import {
  apiErrorBodySchema,
  getModelConfigResponseSchema,
  modelConfigStateSchema,
  probeResultSchema,
  type CredentialActions,
  type GetModelConfigResponse,
  type ModelConfig,
  type ModelConfigState,
  type ModelConnection,
  type ProbeResult,
  type RouteKey,
} from '../../shared/modelConfig.contract'

export const ROUTABLE_TASKS: readonly {
  key: RouteKey
  label: string
  description: string
}[] = [
  {
    key: 'extraction',
    label: 'Extraction & Schema Suggestion',
    description: 'Runs over every Source Document',
  },
  {
    key: 'interaction',
    label: 'Chat & Extraction Schema editing',
    description: 'Interactive, conversational',
  },
]

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

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch (cause) {
    throw new ModelConfigApiError(response.status || 500, 'invalid_response', 'Studio returned invalid JSON.', cause)
  }
}

async function checkedJson(response: Response): Promise<unknown> {
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
  const parsed = getModelConfigResponseSchema.safeParse(await checkedJson(await fetch('/api/model_config', { signal })))
  if (!parsed.success) throw new ModelConfigApiError(500, 'invalid_response', 'Studio returned invalid model configuration state.')
  return parsed.data
}

export async function putModelConfig(
  config: ModelConfig,
  credentials: CredentialActions,
  signal?: AbortSignal,
): Promise<ModelConfigState> {
  const parsed = modelConfigStateSchema.safeParse(
    await checkedJson(
      await fetch('/api/model_config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config, ...(Object.keys(credentials).length ? { credentials } : {}) }),
        signal,
      }),
    ),
  )
  if (!parsed.success) throw new ModelConfigApiError(500, 'invalid_response', 'Studio returned invalid saved state.')
  return parsed.data
}

export async function probeModelConnection(
  connection: ModelConnection,
  options: { credential?: string | null; signal?: AbortSignal } = {},
): Promise<ProbeResult> {
  const body = {
    connection,
    ...(Object.hasOwn(options, 'credential') ? { credential: options.credential } : {}),
  }
  const parsed = probeResultSchema.safeParse(
    await checkedJson(
      await fetch('/api/model_probe', {
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
