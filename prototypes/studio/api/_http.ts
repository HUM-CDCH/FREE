// `FormDataEntryValue` is a DOM global; API modules typecheck with Node types.
export type FormValue = string | File

const MAX_VALIDATION_ISSUES = 20
const MAX_VALIDATION_TEXT = 512
const MAX_UPSTREAM_BYTES = 8192

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown
  override readonly cause: unknown

  constructor(
    status: number,
    code: string,
    message: string,
    options: { details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = options.details
    this.cause = options.cause
  }
}

export type ValidationIssue = { path: string; message: string }

/** Bounds issue count and text so a hostile saved document cannot inflate a response. */
export function boundedValidationDetails(
  path: string,
  issues: readonly ValidationIssue[],
): { path: string; issues: ValidationIssue[]; truncated: boolean } {
  const bound = (value: string): string => Array.from(value).slice(0, MAX_VALIDATION_TEXT).join('')
  return {
    path: bound(path),
    issues: issues.slice(0, MAX_VALIDATION_ISSUES).map(({ path: at, message }) => ({
      path: bound(at),
      message: bound(message),
    })),
    truncated: issues.length > MAX_VALIDATION_ISSUES,
  }
}

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init)
}

/** Persisted research state is never cached by the browser. */
export const noStore = { 'Cache-Control': 'no-store' }

export function boundedLimit(url: URL): number {
  const value = url.searchParams.get('limit') ?? '20'
  if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(value))
    throw new ApiError(
      422,
      'invalid_request',
      'limit must be an integer from 1 to 50.',
    )
  return Number(value)
}

/** One sanitized failure for every unreadable persisted read. */
export function persistenceUnavailable(
  cause: unknown,
  message = 'Project Context storage is unavailable.',
): ApiError {
  return new ApiError(503, 'persistence_unavailable', message, { cause })
}

/** A failed persisted read must not be cached either. */
export function noStoreError(error: unknown): Response {
  const response = apiErrorResponse(error)
  response.headers.set('Cache-Control', noStore['Cache-Control'])
  return response
}

export function apiErrorResponse(error: unknown): Response {
  const mapped =
    error instanceof ApiError
      ? error
      : new ApiError(500, 'unexpected_failure', 'An unexpected failure occurred.', { cause: error })
  const body: { error: { code: string; message: string; details?: unknown } } = {
    error: { code: mapped.code, message: mapped.message },
  }
  if (mapped.details !== undefined) body.error.details = mapped.details
  return json(body, { status: mapped.status })
}

/** Wrong media type and malformed JSON are both structural request failures. */
export async function parseJsonRequest(request: Request): Promise<unknown> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (mediaType !== 'application/json') {
    throw new ApiError(400, 'invalid_request', 'The request must use application/json.')
  }
  try {
    return await request.json()
  } catch (cause) {
    throw new ApiError(400, 'invalid_request', 'The request body must contain valid JSON.', { cause })
  }
}

export async function parseFormRequest(request: Request): Promise<FormData> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (mediaType !== 'multipart/form-data' && mediaType !== 'application/x-www-form-urlencoded') {
    throw new ApiError(400, 'invalid_request', 'The request must contain form data.')
  }
  try {
    return await request.formData()
  } catch (cause) {
    throw new ApiError(400, 'invalid_request', 'The request body contains invalid form data.', { cause })
  }
}

export function assertFormFields(form: FormData, allowedFields: readonly string[]): void {
  const allowed = new Set(allowedFields)
  for (const key of form.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, 'invalid_request', `Unknown form field: ${key}`)
    }
  }
}

export function parseTemperature(value: FormValue | null): number | undefined {
  if (value === null || (typeof value === 'string' && value.trim() === '')) return undefined
  if (typeof value !== 'string') {
    throw new ApiError(400, 'invalid_request', 'temperature must be a number between 0 and 2')
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
    throw new ApiError(400, 'invalid_request', 'temperature must be a number between 0 and 2')
  }
  return parsed
}

export function boundedUpstreamDetail(status: number | null, body: string) {
  const encoded = new TextEncoder().encode(body)
  const truncated = encoded.byteLength > MAX_UPSTREAM_BYTES
  return {
    status,
    body: new TextDecoder().decode(truncated ? encoded.subarray(0, MAX_UPSTREAM_BYTES) : encoded),
    truncated,
  }
}

/** Convert only known provider-response fields; arbitrary thrown objects are never serialized. */
export function asModelOperationError(error: unknown, message = 'The model operation failed.'): ApiError {
  if (error instanceof ApiError) return error
  const data = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {}
  const status = typeof data.statusCode === 'number' ? data.statusCode : null
  const responseBody = typeof data.responseBody === 'string' ? data.responseBody : null
  return new ApiError(502, 'model_operation_failed', message, {
    ...(status !== null || responseBody !== null
      ? { details: { upstream: boundedUpstreamDetail(status, responseBody ?? '') } }
      : {}),
    cause: error,
  })
}
