// ponytail: `FormDataEntryValue` is a DOM global; api/* typechecks with
// types:["node"], where undici keeps the alias module-local. Same shape.
export type FormValue = string | File

const MAX_VALIDATION_ISSUES = 20
const MAX_VALIDATION_TEXT = 512

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

// Retained until the model-operation cutover replaces it with ApiError.
export class RequestError extends Error {
  readonly status: number
  readonly raw: string | null

  constructor(status: number, message: string, raw: string | null = null) {
    super(message)
    this.name = 'RequestError'
    this.status = status
    this.raw = raw
  }
}

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init)
}

export function modelError(error: unknown): Response {
  if (error instanceof RequestError) {
    const detail = error.raw ? { message: error.message, raw: error.raw } : error.message
    return json({ detail }, { status: error.status })
  }

  if (error instanceof Error) {
    return json({ detail: error.message }, { status: 502 })
  }

  return json({ detail: 'Model request failed.' }, { status: 502 })
}

export function parseTemperature(value: FormValue | null): number | undefined {
  if (value === null || typeof value !== 'string' || value.trim() === '') {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
    throw new RequestError(400, 'temperature must be a number between 0 and 2')
  }
  return parsed
}
