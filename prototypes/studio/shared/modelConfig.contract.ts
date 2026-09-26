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
    /** Whether calls to this connection carry a key. The key stays in the researcher's browser and, while a call needs
     *  it, in Studio's memory; never in this document. Managed providers always have one; deployment connections never. */
    hasKey: z.boolean(),
  })
  .strict()
export type ModelConnection = z.infer<typeof modelConnectionSchema>

export const routeSchema = z
  .object({ connectionId: uuidSchema, modelId: z.string().min(1, 'Must not be empty.') })
  .strict()
export type Route = z.infer<typeof routeSchema>

/** A kei-exp extraction model key (`instruct`, `nuextract`, ...): a registry key of the kei-exp deployment, never a
 *  repo id and never a FREE Model Connection's model. */
export const extractionModelKeySchema = z.string().min(1).max(128)

/** An Extraction Model Choice: per role, the kei-exp model key extractions are requested on. An omitted role keeps
 *  kei-exp's deployment default; kei-exp refuses a key it does not serve, or one that cannot take the role. */
export const extractionModelChoiceSchema = z
  .object({ fields: extractionModelKeySchema.optional(), reasoning: extractionModelKeySchema.optional() })
  .strict()
export type ExtractionModelChoice = z.infer<typeof extractionModelChoiceSchema>

/** The roles of kei's `GET /api/ingestion-models`: the model that reads a scanned page, and the detector that finds
 *  its layout. */
export const INGESTION_MODEL_ROLES = ['ocr', 'layout'] as const
export const ingestionModelRoleSchema = z.enum(INGESTION_MODEL_ROLES)
export type IngestionModelRole = z.infer<typeof ingestionModelRoleSchema>
/** A kei model key: a `kei_exp.models.MODELS` key for `ocr`, a `LAYOUT_MODELS` key for `layout`. Never a Model
 *  Connection's model. */
export const ingestionModelKeySchema = z.string().min(1).max(128)
/** An Ingestion Model Choice: per role, the kei model key a conversion runs. An omitted role keeps kei's deployment
 *  default. Any key is stored: kei refuses one it does not serve when it converts, so a saved choice the listing no
 *  longer offers stays saved. */
export const ingestionModelChoiceSchema = z
  .object({ ocr: ingestionModelKeySchema.optional(), layout: ingestionModelKeySchema.optional() })
  .strict()
export type IngestionModelChoice = z.infer<typeof ingestionModelChoiceSchema>

export const modelConfigSchema = z
  .object({
    connections: z.array(modelConnectionSchema),
    routes: z
      .object({
        /** `null` follows the Interaction Route (the Assistant model). */
        schemaSuggestion: routeSchema.nullable(),
        interaction: routeSchema.nullable(),
      })
      .strict(),
    extractionModels: extractionModelChoiceSchema,
    ingestionModels: ingestionModelChoiceSchema,
  })
  .strict()
export type ModelConfig = z.infer<typeof modelConfigSchema>

/**
 * Model connections the deployment itself provides: its vLLM servers and the
 * CLI providers the operator enables. Their UUIDs are reserved: a saved route
 * may name one, a saved connection may not reuse one.
 */
export const DEPLOYMENT_CONNECTION_IDS = {
  instruct: '00000000-0000-4000-8000-00000000d001',
  nuextract: '00000000-0000-4000-8000-00000000d002',
  codexCli: '00000000-0000-4000-8000-00000000d003',
  claudeCode: '00000000-0000-4000-8000-00000000d004',
} as const
export const deploymentModelsSchema = z
  .object({
    connections: z.array(modelConnectionSchema),
    /** What a route left unset runs on; `null` when the deployment serves no instruction model. */
    defaultRoute: routeSchema.nullable(),
  })
  .strict()
export type DeploymentModels = z.infer<typeof deploymentModelsSchema>

export const modelConfigUpdateSchema = z.object({ config: modelConfigSchema }).strict()
export type ModelConfigUpdate = z.infer<typeof modelConfigUpdateSchema>

/** The longest model key Studio accepts: in a probe, in the key handoff and in this browser's key store. */
export const MODEL_KEY_MAX_LENGTH = 8192

/** Printable ASCII (0x20–0x7E) with no space at either end. A key that is no valid header value never reaches a
 *  provider client, whose runtime error would quote the whole `Bearer <key>` header. */
const MODEL_KEY_CHARACTERS = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/

/** A model key as Studio accepts it: in a probe, in the key handoff and in this browser's key store. */
export const modelKeySchema = z.string().min(1).max(MODEL_KEY_MAX_LENGTH).regex(MODEL_KEY_CHARACTERS)

/** Why Studio would refuse a typed, non-empty key, or `null` when it would accept it. */
export function modelKeyIssue(key: string): string | null {
  if (key.length > MODEL_KEY_MAX_LENGTH) return `A key can be at most ${MODEL_KEY_MAX_LENGTH} characters.`
  if (!MODEL_KEY_CHARACTERS.test(key)) return 'A key can contain only printable ASCII characters, with no spaces at either end.'
  return null
}

/** A probe carries exactly the key the page typed or holds for the connection, and only when it has `hasKey`. */
export const modelProbeRequestSchema = z
  .object({ connection: modelConnectionSchema, credential: modelKeySchema.optional() })
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

/** Studio uses NuExtract's own protocol exactly when a route's connection can pass NuExtract's chat-template
 *  controls (vLLM) and its model ID names NuExtract. Only Schema Suggestion runs it. Nothing stores this choice. */
export function usesNuextractProtocol(provider: Pick<ProviderDescriptor, 'supportsNuextract'>, modelId: string): boolean {
  return provider.supportsNuextract && /nuextract/i.test(modelId)
}

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

export const modelConfigStateSchema = z.object({ config: modelConfigSchema }).strict()
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

/** Schema Suggestion's own route, else the Assistant model's (the Interaction Route), else the deployment default.
 *  An explicit Schema Suggestion route stays explicit even when it equals the Interaction Route (decision 12). */
export function selectedRoute(routes: ModelConfig['routes'], key: RouteKey, defaultRoute: Route | null): Route | null {
  return key === 'schemaSuggestion'
    ? routes.schemaSuggestion ?? routes.interaction ?? defaultRoute
    : routes.interaction ?? defaultRoute
}

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

const ingestionModelOptionSchema = z
  .object({ key: ingestionModelKeySchema, label: z.string().min(1), serving: z.boolean() })
  .strict()
export const ingestionModelListingSchema = z
  .object({
    defaults: z.object({ ocr: ingestionModelKeySchema, layout: ingestionModelKeySchema }).strict(),
    models: z.object({ ocr: z.array(ingestionModelOptionSchema), layout: z.array(ingestionModelOptionSchema) }).strict(),
  })
  .strict()
export type IngestionModelListing = z.infer<typeof ingestionModelListingSchema>
