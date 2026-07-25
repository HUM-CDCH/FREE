import { z } from 'zod'

export const providerKindSchema = z.enum([
  'ollama',
  'openai',
  'anthropic',
  'google',
  'codex-cli',
  'claude-code',
  'openai-compatible',
])
export type ProviderKind = z.infer<typeof providerKindSchema>

const connectionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    provider: providerKindSchema,
    baseUrl: z.string().nullable(),
  })
  .strict()
const routeSchema = z.object({ connectionId: z.string(), modelId: z.string() }).strict()
const configSchema = z
  .object({
    connections: z.array(connectionSchema),
    routes: z
      .object({
        extraction: routeSchema.extend({ nuextractRaw: z.literal(true).optional() }).nullable(),
        interaction: routeSchema.nullable(),
      })
      .strict(),
  })
  .strict()
const providerSchema = z
  .object({
    kind: providerKindSchema,
    label: z.string(),
    transport: z.enum(['http', 'cli']),
    defaultBaseUrl: z.string().nullable(),
    authentication: z.enum(['managed', 'optional', 'external']),
    supportsNuextractRaw: z.boolean(),
  })
  .strict()
const credentialStateSchema = z.enum(['present', 'absent', 'unavailable'])
const stateSchema = z
  .object({
    config: configSchema,
    credentialStates: z.record(z.string(), credentialStateSchema),
  })
  .strict()
const getStateSchema = stateSchema.extend({ providers: z.array(providerSchema) }).strict()
const upstreamSchema = z
  .object({ status: z.number().nullable(), body: z.string(), truncated: z.boolean() })
  .strict()
const probeSchema = z
  .object({
    checkedAt: z.string(),
    status: z.enum([
      'connected',
      'authentication_failed',
      'unreachable',
      'not_installed',
      'invalid_response',
      'discovery_failed',
      'timed_out',
    ]),
    message: z.string(),
    catalog: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
    upstream: upstreamSchema.optional(),
  })
  .strict()
const errorSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).strict(),
  })
  .strict()

export type ModelConnection = z.infer<typeof connectionSchema>
export type ModelConfig = z.infer<typeof configSchema>
export type ProviderDescriptor = z.infer<typeof providerSchema>
export type CredentialState = z.infer<typeof credentialStateSchema>
export type CredentialActions = Record<string, string | null>
export type ModelConfigState = z.infer<typeof stateSchema>
export type GetModelConfigResponse = z.infer<typeof getStateSchema>
export type ProbeResult = z.infer<typeof probeSchema>
export type RouteKey = keyof ModelConfig['routes']

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
  const parsed = errorSchema.safeParse(data)
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
  const parsed = getStateSchema.safeParse(await checkedJson(await fetch('/api/model_config', { signal })))
  if (!parsed.success) throw new ModelConfigApiError(500, 'invalid_response', 'Studio returned invalid model configuration state.')
  return parsed.data
}

export async function putModelConfig(
  config: ModelConfig,
  credentials: CredentialActions,
  signal?: AbortSignal,
): Promise<ModelConfigState> {
  const parsed = stateSchema.safeParse(
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
  const parsed = probeSchema.safeParse(
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
