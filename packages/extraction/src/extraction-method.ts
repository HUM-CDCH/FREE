import { z } from 'zod'
import { ExtractionError } from './errors.js'
import type { ExtractionModelChoice, ExtractionStrategy } from './types.js'

const ROLES = ['fields', 'reasoning'] as const

/** A kei-exp extraction model key (`instruct`, `nuextract`, ...): a registry key of the kei-exp deployment, never a
 *  repo id and never a FREE Model Connection's model. */
export const extractionModelKeySchema = z.string().min(1).max(128)

/** An Extraction Model Choice: per role, the kei-exp model key extractions are requested on. An omitted role keeps
 *  kei-exp's deployment default; kei-exp refuses a key it does not serve, or one that cannot take the role. */
export const extractionModelChoiceSchema = z
  .object({ fields: extractionModelKeySchema.optional(), reasoning: extractionModelKeySchema.optional() })
  .strict()

export const ARTICLE_MIN_CONTEXT_TOKENS = 8_192
/** The Parsing Service's reference bounded ceiling; full source uses the served context instead. */
export const ARTICLE_REFERENCE_CONTEXT_TOKENS = 12_288

/** The copy a refused setting shows: beside its field on the Advanced tab and in a refused request's details. */
export const METHOD_MESSAGES = {
  bounded: 'This choice requires bounded source units.',
  schemaPolicy: 'Schema policies require generated quotes or source spans.',
  overflow: 'Choose a verification method to check large claims in windows.',
  contextTokens: 'Enter a whole number of tokens, at least 8,192.',
  overlap: 'Choose 0, 1 or 2 previous passages.',
  inputTokens: 'Enter a whole number of tokens from 512 to 1,048,576, or leave Auto.',
  replyTokens: 'Enter a whole number of tokens from 64 to 65,536, or use the stage defaults.',
  catalogOverlap: 'Choose from 0 to 4 source lines.',
  catalogCandidates: 'Choose from 1 to 1024 context excerpts.',
} as const

const wholeNumber = (message: string, minimum: number) => z.number({ error: message }).int(message).min(minimum, message)
const optionalFactor = <T extends string>(value: T) => z.literal(value).nullable().optional()

/** Article's method: the Parsing Service's `ArticleOptions` (`kie/extract/method.py`) field for field, with its
 *  defaults. Its cross-field rules are `articleSettingsIssues`, so every refusal names the field it concerns. */
export const articleSettingsSchema = z.object({
  context: z.enum(['full', 'bounded']).default('full'),
  context_tokens: wholeNumber(METHOD_MESSAGES.contextTokens, ARTICLE_MIN_CONTEXT_TOKENS).default(ARTICLE_REFERENCE_CONTEXT_TOKENS),
  overlap_passages: wholeNumber(METHOD_MESSAGES.overlap, 0).max(2, METHOD_MESSAGES.overlap).default(0),
  grounding: z.enum(['semantic', 'quoted', 'spans', 'off']).default('semantic'),
  evidence_policy: optionalFactor('schema'),
  rendering: optionalFactor('structured'),
  grouping: optionalFactor('structural'),
  grounding_overflow: optionalFactor('windows'),
}).strict()
export type ArticleSettings = z.output<typeof articleSettingsSchema>

/** `ArticleOptions` field order: saved, compared and sent Article settings keep it, so equal drafts serialize alike. */
export const ARTICLE_KEYS = [
  'context', 'context_tokens', 'overlap_passages', 'grounding',
  'evidence_policy', 'rendering', 'grouping', 'grounding_overflow',
] as const satisfies readonly (keyof ArticleSettings)[]

/** Article's shared default: the whole source, with oversized checks read in windows. */
export const REFERENCE_ARTICLE: ArticleSettings = Object.freeze(articleSettingsSchema.parse({ grounding_overflow: 'windows' }))

/** The unified Catalog's service defaults (`unified.py` `DEFAULTS`), pinned to it by the shared contract fixture:
 *  reply reserves per stage, overlap in source lines, heading context, window halvings, and an entry reply that may
 *  use the context its counted input leaves (its reserve the floor). Each value is read once; a value located in its
 *  record's own text is linked by rule; one inherited from a heading is accepted only when an independent reading
 *  agrees. Auto input is the served context minus the stage's reserve. Only `UNIFIED_CATALOG_DEFAULTS_VERSION` is
 *  admitted: the number is provenance, never a switch. */
const UNIFIED_BASE = {
  reserves: { discovery: 4_096, entry: 4_096, verification: 2_048, arbitration: 512, document: 2_048 },
  headings: true, splits: 6,
} as const
export const UNIFIED_CATALOG_DEFAULTS_VERSION = 12 as const
export const UNIFIED_CATALOG_DEFAULTS = {
  [UNIFIED_CATALOG_DEFAULTS_VERSION]: { ...UNIFIED_BASE, overlap: 3, entry_reply: 'context' },
} as const

/** The unified Catalog's five controls as the account saves them: each an override, absent for the defaults. */
export const unifiedCatalogPreferenceSchema = z.object({
  input_tokens: wholeNumber(METHOD_MESSAGES.inputTokens, 512).max(1_048_576, METHOD_MESSAGES.inputTokens).optional(),
  output_tokens: wholeNumber(METHOD_MESSAGES.replyTokens, 64).max(65_536, METHOD_MESSAGES.replyTokens).optional(),
  overlap: wholeNumber(METHOD_MESSAGES.catalogOverlap, 0).max(4, METHOD_MESSAGES.catalogOverlap).optional(),
  candidates: wholeNumber(METHOD_MESSAGES.catalogCandidates, 1).max(1_024, METHOD_MESSAGES.catalogCandidates).optional(),
  headings: z.boolean().optional(),
}).strict()
export type UnifiedCatalogPreference = z.output<typeof unifiedCatalogPreferenceSchema>
/** The unified Catalog method one Extraction is admitted with (`options.unified`): the defaults version it runs under
 *  and the overrides, so it stays identifiable when every control is left to the defaults. */
export const unifiedCatalogSettingsSchema = unifiedCatalogPreferenceSchema.extend({
  defaults: z.literal(UNIFIED_CATALOG_DEFAULTS_VERSION),
}).strict()
export type UnifiedCatalogSettings = z.output<typeof unifiedCatalogSettingsSchema>
const UNIFIED_KEYS = ['defaults', 'input_tokens', 'output_tokens', 'overlap', 'candidates', 'headings'] as const

/** One group of Catalog controls for single and batch work. */
export const catalogSettingsSchema = z.object({ unified: unifiedCatalogPreferenceSchema.optional() }).strict()
export type CatalogSettings = z.output<typeof catalogSettingsSchema>

/** A Researcher Account's saved method settings per strategy. An absent member means service defaults. */
export const extractionSettingsSchema = z.object({
  article: articleSettingsSchema.optional(),
  catalog: catalogSettingsSchema.optional(),
}).strict()
export type ExtractionSettings = z.output<typeof extractionSettingsSchema>

export type MethodIssue = Readonly<{ path: string; message: string }>

/** The service's cross-field rules (`ArticleOptions.coherent`), each addressed to the choice that breaks it. */
export function articleSettingsIssues(article: ArticleSettings): MethodIssue[] {
  const issues: MethodIssue[] = []
  const bounded = article.context === 'bounded'
  const verifiesQuotes = article.grounding === 'quoted' || article.grounding === 'spans'
  if (article.overlap_passages > 0 && !bounded) issues.push({ path: 'overlap_passages', message: METHOD_MESSAGES.bounded })
  if (article.grouping && !bounded) issues.push({ path: 'grouping', message: METHOD_MESSAGES.bounded })
  if (article.evidence_policy && !verifiesQuotes) issues.push({ path: 'evidence_policy', message: METHOD_MESSAGES.schemaPolicy })
  if (article.grounding_overflow && article.grounding === 'off')
    issues.push({ path: 'grounding_overflow', message: METHOD_MESSAGES.overflow })
  return issues
}

export function extractionSettingsIssues(settings: ExtractionSettings): MethodIssue[] {
  return settings.article
    ? articleSettingsIssues(settings.article).map((issue) => ({ ...issue, path: `article.${issue.path}` }))
    : []
}

export function settingsShapeIssues(error: z.ZodError, prefix = ''): MethodIssue[] {
  return error.issues.map((issue) => ({ path: [prefix, ...issue.path.map(String)].filter(Boolean).join('.'), message: issue.message }))
}

/** What the Parsing Service's `ArticleOptions` accepts, with field-addressed issues: the parity entry point. */
export function validateArticleOptions(input: unknown):
  | { ok: true; value: ArticleSettings }
  | { ok: false; issues: MethodIssue[] } {
  const parsed = articleSettingsSchema.safeParse(input)
  if (!parsed.success) return { ok: false, issues: settingsShapeIssues(parsed.error) }
  const issues = articleSettingsIssues(parsed.data)
  return issues.length === 0 ? { ok: true, value: parsed.data } : { ok: false, issues }
}

/** The explicit Article method as saved, compared and sent: every required field, optional factors only when chosen
 *  (never null), keys in `ArticleOptions` order. Full source uses the served context size, so its unused ceiling
 *  returns to the reference value (design §2). Only for settings without issues. */
export function canonicalArticle(article: ArticleSettings): ArticleSettings {
  const canonical: Record<string, unknown> = {}
  for (const key of ARTICLE_KEYS) {
    const value = key === 'context_tokens' && article.context === 'full' ? ARTICLE_REFERENCE_CONTEXT_TOKENS : article[key]
    if (value !== null && value !== undefined) canonical[key] = Array.isArray(value) ? [...value] : value
  }
  return canonical as ArticleSettings
}

/** The set values of `keys`, in that order; none is service defaults, i.e. absent: the service dumps its defaults alike. */
function present<T extends object>(value: T | null | undefined, keys: readonly (keyof T)[]): T | undefined {
  if (value === null || value === undefined) return undefined
  const kept = keys.flatMap((key) => (value[key] === null || value[key] === undefined ? [] : [[key, value[key]] as const]))
  return kept.length === 0 ? undefined : (Object.fromEntries(kept) as T)
}

/** The unified method as admitted, compared and sent: the defaults version and the set overrides, in option order. */
export function canonicalUnified(preference: UnifiedCatalogPreference | UnifiedCatalogSettings | null | undefined): UnifiedCatalogSettings {
  return present<UnifiedCatalogSettings>({ defaults: UNIFIED_CATALOG_DEFAULTS_VERSION, ...preference },
    UNIFIED_KEYS)!
}

/** Saved settings as stored: an explicit Article in full, Catalog members only when they carry a value. */
export function canonicalExtractionSettings(settings: ExtractionSettings): ExtractionSettings {
  const unified = present(settings.catalog?.unified, UNIFIED_KEYS.slice(1) as readonly (keyof UnifiedCatalogPreference)[])
  return {
    ...(settings.article ? { article: canonicalArticle(settings.article) } : {}),
    ...(unified ? { catalog: { unified } } : {}),
  }
}

/** The explicitly pinned settings one Extraction uses, as it is compared, pinned and recorded. */
export const activeSettingsSchema = z.union([
  z.object({ article: articleSettingsSchema }).strict(),
  z.object({ unified: unifiedCatalogSettingsSchema }).strict(),
])
export type ActiveSettings = z.output<typeof activeSettingsSchema>
export type SettingsSlot = 'article' | 'unified'

export function settingsSlot(strategy: ExtractionStrategy): SettingsSlot {
  return strategy === 'ARTICLE' ? 'article' : 'unified'
}

/** Only the settings belonging to the declared strategy can run. */
export function settingsFit(strategy: ExtractionStrategy, settings: object): boolean {
  return settingsSlot(strategy) in settings
}

export function activeSettings(settings: ExtractionSettings, strategy: ExtractionStrategy): ActiveSettings {
  const canonical = canonicalExtractionSettings(settings)
  return strategy === 'ARTICLE'
    ? { article: canonical.article ?? REFERENCE_ARTICLE }
    : { unified: canonicalUnified(canonical.catalog?.unified) }
}

/** What a start view shows and submits, and what admission compares and pins: the Extraction Model Choice and the
 *  applicable saved settings. Never a key, a connection or a preset name. */
export const extractionMethodIntentSchema = z.object({
  models: extractionModelChoiceSchema.nullable(),
  settings: activeSettingsSchema,
}).strict()
export type ExtractionMethodIntent = Readonly<{ models: ExtractionModelChoice | null; settings: ActiveSettings }>

export function activeMethod(
  models: unknown, settings: ExtractionSettings, strategy: ExtractionStrategy,
): ExtractionMethodIntent {
  return { models: modelChoice(models), settings: activeSettings(settings, strategy) }
}

const accountMembersSchema = z.object({ extractionModels: extractionModelChoiceSchema, extractionSettings: extractionSettingsSchema })

/** The active method a stored account document (Studio's whole Model Configuration document, or null before its
 *  first Apply) gives one Extraction. Studio validates the document on every write, so one that fails here is refused,
 *  never read as defaults. */
export function accountMethod(
  document: unknown, strategy: ExtractionStrategy,
): ExtractionMethodIntent {
  if (document === null) return activeMethod(null, {}, strategy)
  const members = accountMembersSchema.safeParse(document)
  if (!members.success || extractionSettingsIssues(members.data.extractionSettings).length > 0)
    throw new ExtractionError('invalid_model_config', 'The saved model configuration is invalid.')
  return activeMethod(members.data.extractionModels, members.data.extractionSettings, strategy)
}

/** A submitted intent in the form admission compares, or null when it is malformed, breaks a rule, or names another
 *  strategy's settings. */
export function canonicalIntent(value: unknown, strategy: ExtractionStrategy): ExtractionMethodIntent | null {
  const parsed = extractionMethodIntentSchema.safeParse(value)
  if (!parsed.success || !settingsFit(strategy, parsed.data.settings)) return null
  const settings = parsed.data.settings as Partial<Record<SettingsSlot, unknown>>
  const slot = 'unified' in settings ? 'unified' : settingsSlot(strategy)
  const models = modelChoice(parsed.data.models)
  if (slot === 'unified') return { models, settings: { unified: canonicalUnified(settings.unified as UnifiedCatalogSettings) } }
  if (slot === 'article') {
    const article = settings.article as ArticleSettings
    return articleSettingsIssues(article).length > 0 ? null : { models, settings: { article: canonicalArticle(article) } }
  }
  return null
}

/** An Extraction's validated, explicitly recorded settings. */
export function storedSettings(value: unknown, strategy: ExtractionStrategy): ActiveSettings {
  const parsed = activeSettingsSchema.safeParse(value)
  if (!parsed.success || !settingsFit(strategy, parsed.data))
    throw new ExtractionError('invalid_extraction_method', 'The admitted extraction method is invalid.')
  return parsed.data
}

export const recordedSettings = storedSettings

/** A choice from a request or stored jsonb value: absent, null and empty roles all mean service defaults. */
export function modelChoice(value: unknown): ExtractionModelChoice | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const chosen: { fields?: string; reasoning?: string } = {}
  for (const role of ROLES) {
    const key = (value as Record<string, unknown>)[role]
    if (typeof key === 'string' && key !== '') chosen[role] = key
  }
  return Object.keys(chosen).length === 0 ? null : chosen
}

export type ExtractionMethod = Readonly<{
  strategy: ExtractionStrategy
  requestedModels: ExtractionModelChoice | null
  /** The explicitly admitted settings. */
  requestedSettings: ActiveSettings
}>

/** The pinned method; unchosen model roles use deployment defaults. */
export function extractionMethod(
  strategy: ExtractionStrategy,
  requestedModels: unknown,
  requestedSettings: unknown,
): ExtractionMethod {
  return {
    strategy,
    requestedModels: modelChoice(requestedModels),
    requestedSettings: storedSettings(requestedSettings, strategy),
  }
}

/** The Parsing Service's options for the same pinned method. */
export function keiMethodOptions(method: ExtractionMethod): Record<string, unknown> {
  const settings = method.requestedSettings
  const article = 'article' in settings ? settings.article : null
  const unified = 'unified' in settings ? settings.unified : null
  if (method.strategy === 'CATALOG' && !unified)
    throw new ExtractionError('invalid_extraction_method', 'Catalog requires unified settings.')
  return {
    strategy: method.strategy === 'CATALOG' ? 'catalog' : 'article',
    ...(method.requestedModels === null ? {} : { models: method.requestedModels }),
    ...(unified ? { unified: canonicalUnified(unified) } : {}),
    ...(method.strategy === 'ARTICLE' && article ? { article: canonicalArticle(article) } : {}),
  }
}
