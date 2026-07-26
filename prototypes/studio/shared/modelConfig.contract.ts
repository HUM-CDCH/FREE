import { z } from 'zod'

export const PROVIDER_KINDS = [
  'ollama',
  'openai',
  'anthropic',
  'google',
  'codex-cli',
  'claude-code',
  'openai-compatible',
] as const
export const providerKindSchema = z.enum(PROVIDER_KINDS)
export type ProviderKind = z.infer<typeof providerKindSchema>

export const uuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  'Must be a canonical lowercase UUID.',
)

export const modelConnectionSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1, 'Must not be empty.'),
    provider: providerKindSchema,
    baseUrl: z.string().min(1).nullable(),
  })
  .strict()
export type ModelConnection = z.infer<typeof modelConnectionSchema>

export const routeSchema = z
  .object({ connectionId: uuidSchema, modelId: z.string().min(1, 'Must not be empty.') })
  .strict()
export type Route = z.infer<typeof routeSchema>

export const modelConfigSchema = z
  .object({
    connections: z.array(modelConnectionSchema),
    routes: z
      .object({
        extraction: routeSchema.extend({ nuextractRaw: z.literal(true).optional() }).nullable(),
        interaction: routeSchema.nullable(),
      })
      .strict(),
  })
  .strict()
export type ModelConfig = z.infer<typeof modelConfigSchema>

export const modelConfigUpdateSchema = z
  .object({
    config: modelConfigSchema,
    credentials: z
      .record(uuidSchema, z.string().min(1, 'Must not be empty.').nullable())
      .optional(),
  })
  .strict()
export type ModelConfigUpdate = z.infer<typeof modelConfigUpdateSchema>

export const modelProbeRequestSchema = z
  .object({
    connection: modelConnectionSchema,
    credential: z.string().min(1, 'Must not be empty.').nullable().optional(),
  })
  .strict()
export type ModelProbeRequest = z.infer<typeof modelProbeRequestSchema>

export const providerDescriptorSchema = z
  .object({
    kind: providerKindSchema,
    label: z.string(),
    transport: z.enum(['http', 'cli']),
    defaultBaseUrl: z.string().nullable(),
    authentication: z.enum(['managed', 'optional', 'external']),
    supportsNuextractRaw: z.boolean(),
  })
  .strict()
export type ProviderDescriptor = z.infer<typeof providerDescriptorSchema>

export const credentialStateSchema = z.enum(['present', 'absent', 'unavailable'])
export type CredentialState = z.infer<typeof credentialStateSchema>
/** Omitted ID preserves, non-empty string replaces, `null` deletes. */
export type CredentialActions = Record<string, string | null>

export const modelDescriptorSchema = z.object({ id: z.string(), label: z.string() }).strict()
export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>

export const PROBE_STATUSES = [
  'connected',
  'authentication_failed',
  'unreachable',
  'not_installed',
  'invalid_response',
  'discovery_failed',
  'timed_out',
] as const
export const probeStatusSchema = z.enum(PROBE_STATUSES)
export type ProbeStatus = z.infer<typeof probeStatusSchema>

export const immediateUpstreamDetailSchema = z
  .object({ status: z.number().nullable(), body: z.string(), truncated: z.boolean() })
  .strict()
export type ImmediateUpstreamDetail = z.infer<typeof immediateUpstreamDetailSchema>

export const probeResultSchema = z
  .object({
    checkedAt: z.string(),
    status: probeStatusSchema,
    message: z.string(),
    catalog: z.array(modelDescriptorSchema),
    upstream: immediateUpstreamDetailSchema.optional(),
  })
  .strict()
export type ProbeResult = z.infer<typeof probeResultSchema>

export const modelConfigStateSchema = z
  .object({
    config: modelConfigSchema,
    credentialStates: z.record(z.string(), credentialStateSchema),
  })
  .strict()
export type ModelConfigState = z.infer<typeof modelConfigStateSchema>

export const getModelConfigResponseSchema = modelConfigStateSchema
  .extend({ providers: z.array(providerDescriptorSchema) })
  .strict()
export type GetModelConfigResponse = z.infer<typeof getModelConfigResponseSchema>

export const apiErrorBodySchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).strict(),
  })
  .strict()
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>

/** The `details` shape `boundedValidationDetails` attaches to a rejected configuration. */
export const validationDetailsSchema = z
  .object({
    path: z.string(),
    issues: z.array(z.object({ path: z.string(), message: z.string() }).strict()),
    truncated: z.boolean(),
  })
  .strict()
export type ValidationDetails = z.infer<typeof validationDetailsSchema>

export type RouteKey = keyof ModelConfig['routes']

export function apiBaseIssue(value: string): string | null {
  if (value.trim() !== value) return 'API base must not have surrounding whitespace.'
  if (/\p{Cc}/u.test(value)) return 'API base must not contain control characters.'
  if (value.includes('\\')) return 'API base must not contain backslashes.'

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return 'API base must be an absolute HTTP or HTTPS URL.'
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.host === '') {
    return 'API base must be an absolute HTTP or HTTPS URL.'
  }
  const authority = /^https?:\/\/([^/?#]*)/i.exec(value)?.[1] ?? ''
  if (parsed.username !== '' || parsed.password !== '' || authority.includes('@')) {
    return 'API base must not contain embedded userinfo.'
  }
  if (parsed.search !== '') return 'API base must not contain a query.'
  if (parsed.hash !== '') return 'API base must not contain a fragment.'
  return null
}

export function isValidApiBase(value: string | null): boolean {
  return value !== null && apiBaseIssue(value) === null
}
