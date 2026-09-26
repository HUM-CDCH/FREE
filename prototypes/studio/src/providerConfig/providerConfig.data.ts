import { authenticatedFetch } from '../auth/authenticatedFetch.ts'
import {
  apiErrorBodySchema,
  getModelConfigResponseSchema,
  modelConfigStateSchema,
  probeResultSchema,
  type GetModelConfigResponse,
  type ModelConfig,
  type ModelConfigState,
  type ModelConnection,
  type ProbeResult,
  validationDetailsSchema,
} from '../../shared/modelConfig.contract'

export class ModelConfigApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ModelConfigApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * The one renderable form of a failed configuration or probe request. Validation
 * issues are included because they name the offending field, which `code` and
 * `message` alone never do: an empty model ID would otherwise read only as
 * `invalid_request: The request is invalid.`
 */
export function apiErrorText(error: unknown): string {
  if (!(error instanceof ModelConfigApiError)) {
    return 'unexpected_failure: An unexpected failure occurred.'
  }
  const details = validationDetailsSchema.safeParse(error.details)
  const lines = [`${error.code}: ${error.message}`]
  if (details.success) {
    lines.push(...details.data.issues.map(({ path, message }) => `${path}: ${message}`))
    if (details.data.truncated) lines.push('Further issues were omitted.')
  }
  return lines.join('\n')
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch (cause) {
    throw new ModelConfigApiError(response.status || 500, 'invalid_response', 'Studio returned invalid JSON.', cause)
  }
}

export async function checkedJson(response: Response): Promise<unknown> {
  const data = await responseJson(response)
  if (response.ok) return data
  const parsed = apiErrorBodySchema.safeParse(data)
  if (parsed.success) {
    throw new ModelConfigApiError(
      response.status,
      parsed.data.error.code,
      parsed.data.error.message,
      parsed.data.error.details,
    )
  }
  throw new ModelConfigApiError(response.status, 'invalid_response', `Studio request failed (${response.status}).`)
}

export async function getModelConfig(signal?: AbortSignal): Promise<GetModelConfigResponse> {
  const parsed = getModelConfigResponseSchema.safeParse(await checkedJson(await authenticatedFetch('/api/model_config', { signal })))
  if (!parsed.success) throw new ModelConfigApiError(500, 'invalid_response', 'Studio returned invalid model configuration state.')
  return parsed.data
}

/** Saves the whole document. It carries no key: keys reach Studio only through `PUT /api/model-keys`. */
export async function putModelConfig(config: ModelConfig, signal?: AbortSignal): Promise<ModelConfigState> {
  const parsed = modelConfigStateSchema.safeParse(
    await checkedJson(
      await authenticatedFetch('/api/model_config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config }),
        signal,
      }),
    ),
  )
  if (!parsed.success) throw new ModelConfigApiError(500, 'invalid_response', 'Studio returned invalid saved state.')
  return parsed.data
}

/** Probes with exactly the key the page supplies, which Studio requires for a connection with `hasKey`. */
export async function probeModelConnection(
  connection: ModelConnection,
  options: { credential?: string; signal?: AbortSignal } = {},
): Promise<ProbeResult> {
  const body = {
    connection,
    ...(options.credential === undefined ? {} : { credential: options.credential }),
  }
  const parsed = probeResultSchema.safeParse(
    await checkedJson(
      await authenticatedFetch('/api/model_probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: options.signal,
      }),
    ),
  )
  if (!parsed.success) throw new ModelConfigApiError(500, 'invalid_response', 'Studio returned an invalid probe result.')
  return parsed.data
}
