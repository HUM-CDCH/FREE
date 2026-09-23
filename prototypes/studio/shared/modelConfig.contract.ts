import { CANONICAL_UUID } from 'studio-configuration'
import { z } from 'zod'

export const PROVIDER_KINDS = [
  'ollama',
  'openai',
  'anthropic',
  'google',
  'codex-cli',
  'claude-code',
  'openai-compatible',
  'vllm',
] as const
export const providerKindSchema = z.enum(PROVIDER_KINDS)
export type ProviderKind = z.infer<typeof providerKindSchema>

export const uuidSchema = z
  .string()
  .regex(CANONICAL_UUID, 'Must be a canonical lowercase UUID.')

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

/** NuExtract's own chat-template controls, which only a vLLM connection passes through. */
export const schemaSuggestionRouteSchema = routeSchema
  .extend({ protocol: z.literal('nuextract').optional() })
  .strict()
export type SchemaSuggestionRoute = z.infer<typeof schemaSuggestionRouteSchema>

/** A kei-exp extraction model key (`instruct`, `nuextract`, ...): a registry key of the kei-exp deployment, never a
 *  repo id and never a FREE Model Connection's model. */
export const extractionModelKeySchema = z.string().min(1).max(128)

/** An Extraction Model Choice: per role, the kei-exp model key extractions are requested on. An omitted role keeps
 *  kei-exp's deployment default; kei-exp refuses a key it does not serve, or one that cannot take the role. */
export const extractionModelChoiceSchema = z
  .object({ fields: extractionModelKeySchema.optional(), reasoning: extractionModelKeySchema.optional() })
  .strict()
export type ExtractionModelChoice = z.infer<typeof extractionModelChoiceSchema>

export const modelConfigSchema = z
  .object({
    connections: z.array(modelConnectionSchema),
    routes: z
      .object({
        schemaSuggestion: schemaSuggestionRouteSchema.nullable(),
        interaction: routeSchema.nullable(),
      })
      .strict(),
    extractionModels: extractionModelChoiceSchema,
  })
  .strict()
export type ModelConfig = z.infer<typeof modelConfigSchema>

/**
 * Model servers the deployment itself runs. Their UUIDs are reserved: a saved
 * route may name one, a saved connection may not reuse one.
 */
export const DEPLOYMENT_CONNECTION_IDS = {
  instruct: '00000000-0000-4000-8000-00000000d001',
  nuextract: '00000000-0000-4000-8000-00000000d002',
} as const
export const deploymentModelsSchema = z
  .object({
    connections: z.array(modelConnectionSchema),
    /** What a route left unset runs on; `null` when the deployment serves no instruction model. */
    defaultRoute: routeSchema.nullable(),
  })
  .strict()
export type DeploymentModels = z.infer<typeof deploymentModelsSchema>

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
    supportsNuextract: z.boolean(),
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

export const probeResultSchema = z
  .object({
    checkedAt: z.string(),
    status: probeStatusSchema,
    message: z.string(),
    catalog: z.array(modelDescriptorSchema),
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
  .extend({ providers: z.array(providerDescriptorSchema), deployment: deploymentModelsSchema })
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
