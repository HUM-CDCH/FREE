import { z } from 'zod'
import { isScalarFieldType } from './allowed-values.js'
import { ExtractionError } from './errors.js'
import type { SchemaNode } from './schema.js'
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
/** The Parsing Service's Catalog defaults (`run.py` `Options`, `grounded.py` `CatalogOptions`). */
export const CATALOG_DEFAULTS = { discovery_chars: 48_000, record_chars: 24_000, input_tokens: 4_096, output_tokens: 1_024 } as const

/** The copy a refused setting shows: beside its field on the Advanced tab and in a refused request's details. */
export const METHOD_MESSAGES = {
  bounded: 'This choice requires bounded source units.',
  schemaPolicy: 'Schema policies require generated quotes or source spans.',
  schedule: 'Choose a verification method to use this schedule.',
  routing: 'Use generated quotes or source spans, and stop after support.',
  identity: 'Add the scalar record fields that identify one record.',
  identityNames: 'Each identity field needs its own non-empty name.',
  identityLimit: 'Use at most 32 identity fields, each at most 128 characters.',
  contextTokens: 'Enter a whole number of tokens, at least 8,192.',
  overlap: 'Choose 0, 1 or 2 previous passages.',
  characters: 'Enter a whole number of characters, at least 1,000.',
  budgetTokens: 'Enter a whole number of tokens, at least 64.',
  inputTokens: 'Enter a whole number of tokens from 512 to 1,048,576, or leave Auto.',
  replyTokens: 'Enter a whole number of tokens from 64 to 65,536, or use the stage defaults.',
  catalogOverlap: 'Choose from 0 to 4 source lines.',
  migration: 'Review the unified Catalog settings and apply them before starting a Catalog Extraction.',
} as const

const wholeNumber = (message: string, minimum: number) => z.number({ error: message }).int(message).min(minimum, message)
const optionalFactor = <T extends string>(value: T) => z.literal(value).nullable().optional()

/** Article's method: the Parsing Service's `ArticleOptions` (`kie/extract/method.py`) field for field, with its
 *  defaults. Its cross-field rules are `articleSettingsIssues`, so every refusal names the field it concerns. */
export const articleSettingsSchema = z.object({
  context: z.enum(['full', 'bounded']).default('full'),
  context_tokens: wholeNumber(METHOD_MESSAGES.contextTokens, ARTICLE_MIN_CONTEXT_TOKENS).default(ARTICLE_REFERENCE_CONTEXT_TOKENS),
  overlap_passages: wholeNumber(METHOD_MESSAGES.overlap, 0).max(2, METHOD_MESSAGES.overlap).default(0),
  identity: z.enum(['reference', 'conservative']).default('reference'),
  identity_fields: z.array(z.string().min(1, METHOD_MESSAGES.identityNames).max(128, METHOD_MESSAGES.identityLimit))
    .max(32, METHOD_MESSAGES.identityLimit).default([]),
  prompt: z.enum(['reference', 'schema']).default('reference'),
  grounding: z.enum(['semantic', 'quoted', 'spans', 'off']).default('semantic'),
  grounding_schedule: optionalFactor('unresolved'),
  evidence_policy: optionalFactor('schema'),
  grounding_routing: optionalFactor('origin_lexical'),
  selection: optionalFactor('supported'),
  rendering: optionalFactor('structured'),
  grouping: optionalFactor('structural'),
}).strict()
export type ArticleSettings = z.output<typeof articleSettingsSchema>

/** `ArticleOptions` field order: saved, compared and sent Article settings keep it, so equal drafts serialize alike. */
export const ARTICLE_KEYS = [
  'context', 'context_tokens', 'overlap_passages', 'identity', 'identity_fields', 'prompt', 'grounding',
  'grounding_schedule', 'evidence_policy', 'grounding_routing', 'selection', 'rendering', 'grouping',
] as const satisfies readonly (keyof ArticleSettings)[]

/** The explicit reference Customize starts from: every required field, no optional factor. */
export const REFERENCE_ARTICLE: ArticleSettings = Object.freeze(articleSettingsSchema.parse({}))

export const genericCatalogSettingsSchema = z.object({
  discovery_chars: wholeNumber(METHOD_MESSAGES.characters, 1_000).optional(),
  record_chars: wholeNumber(METHOD_MESSAGES.characters, 1_000).optional(),
}).strict()
export type GenericCatalogSettings = z.output<typeof genericCatalogSettingsSchema>

/** Recipe factors: `CatalogFactors`. Present factors are complete; each unset switch is on, as the service reads it. */
export const catalogFactorsSchema = z.object({
  glossary: z.boolean().default(true),
  headings: z.boolean().default(true),
  overlap: z.boolean().default(true),
  verification: z.boolean().default(true),
}).strict()
type CatalogFactors = z.output<typeof catalogFactorsSchema>
export const recipeCatalogSettingsSchema = z.object({
  input_tokens: wholeNumber(METHOD_MESSAGES.budgetTokens, 64).optional(),
  output_tokens: wholeNumber(METHOD_MESSAGES.budgetTokens, 64).optional(),
  factors: catalogFactorsSchema.optional(),
}).strict()
export type RecipeCatalogSettings = z.output<typeof recipeCatalogSettingsSchema>

/** The unified Catalog's versioned service defaults (`unified.py` `DEFAULTS`), pinned to it by the shared contract
 *  fixture: reply reserves per stage, overlap in source lines, heading context, verification and window halvings.
 *  Auto input is the served context minus the stage's reserve. */
export const UNIFIED_CATALOG_DEFAULTS = {
  1: {
    reserves: { discovery: 4_096, entry: 4_096, verification: 2_048, arbitration: 512, document: 2_048 },
    overlap: 1, headings: true, verification: true, splits: 6,
  },
} as const
export const UNIFIED_CATALOG_DEFAULTS_VERSION = 1 as const

/** The unified Catalog's five controls as the account saves them: each an override, absent for the defaults. */
export const unifiedCatalogPreferenceSchema = z.object({
  input_tokens: wholeNumber(METHOD_MESSAGES.inputTokens, 512).max(1_048_576, METHOD_MESSAGES.inputTokens).optional(),
  output_tokens: wholeNumber(METHOD_MESSAGES.replyTokens, 64).max(65_536, METHOD_MESSAGES.replyTokens).optional(),
  overlap: wholeNumber(METHOD_MESSAGES.catalogOverlap, 0).max(4, METHOD_MESSAGES.catalogOverlap).optional(),
  headings: z.boolean().optional(),
  verification: z.boolean().optional(),
}).strict()
export type UnifiedCatalogPreference = z.output<typeof unifiedCatalogPreferenceSchema>
/** The unified Catalog method one Extraction is admitted with (`options.unified`): the defaults version it runs under
 *  and the overrides, so it stays identifiable when every control is left to the defaults. */
export const unifiedCatalogSettingsSchema = unifiedCatalogPreferenceSchema.extend({
  defaults: z.literal(UNIFIED_CATALOG_DEFAULTS_VERSION),
}).strict()
export type UnifiedCatalogSettings = z.output<typeof unifiedCatalogSettingsSchema>
const UNIFIED_KEYS = ['defaults', 'input_tokens', 'output_tokens', 'overlap', 'headings', 'verification'] as const

/** New Catalog admissions use the unified method only where the deployment enables it; until its release gates
 *  pass, the default remains the legacy generic and recipe Catalog. */
export function unifiedCatalogEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return environment.FREE_CATALOG_METHOD === 'unified'
}

/** Legacy generic and recipe Catalog are saved apart (the recipe is chosen per Extraction); the unified Catalog
 *  has one group of controls for single and batch work alike. */
export const catalogSettingsSchema = z.object({
  generic: genericCatalogSettingsSchema.optional(),
  recipe: recipeCatalogSettingsSchema.optional(),
  unified: unifiedCatalogPreferenceSchema.optional(),
}).strict()
export type CatalogSettings = z.output<typeof catalogSettingsSchema>

export const REFERENCE_CATALOG: CatalogSettings = Object.freeze({
  generic: { discovery_chars: CATALOG_DEFAULTS.discovery_chars, record_chars: CATALOG_DEFAULTS.record_chars },
  recipe: {
    input_tokens: CATALOG_DEFAULTS.input_tokens, output_tokens: CATALOG_DEFAULTS.output_tokens,
    factors: { glossary: true, headings: true, overlap: true, verification: true },
  },
})

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
  if (article.selection && !bounded) issues.push({ path: 'selection', message: METHOD_MESSAGES.bounded })
  if (article.grouping && !bounded) issues.push({ path: 'grouping', message: METHOD_MESSAGES.bounded })
  if (article.evidence_policy && !verifiesQuotes) issues.push({ path: 'evidence_policy', message: METHOD_MESSAGES.schemaPolicy })
  if (article.grounding_schedule && article.grounding === 'off')
    issues.push({ path: 'grounding_schedule', message: METHOD_MESSAGES.schedule })
  if (article.grounding_routing && (!verifiesQuotes || article.grounding_schedule !== 'unresolved'))
    issues.push({ path: 'grounding_routing', message: METHOD_MESSAGES.routing })
  if (article.identity === 'conservative' && article.identity_fields.length === 0)
    issues.push({ path: 'identity_fields', message: METHOD_MESSAGES.identity })
  if (new Set(article.identity_fields).size !== article.identity_fields.length)
    issues.push({ path: 'identity_fields', message: METHOD_MESSAGES.identityNames })
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

/** Catalog key orders (`Options`, `CatalogOptions`, `CatalogFactors`): like Article's, so equal settings serialize alike. */
const GENERIC_KEYS = ['discovery_chars', 'record_chars'] as const satisfies readonly (keyof GenericCatalogSettings)[]
const RECIPE_KEYS = ['input_tokens', 'output_tokens', 'factors'] as const satisfies readonly (keyof RecipeCatalogSettings)[]
const FACTOR_KEYS = ['glossary', 'headings', 'overlap', 'verification'] as const satisfies readonly (keyof CatalogFactors)[]

/** The set values of `keys`, in that order; none is service defaults, i.e. absent: the service dumps its defaults alike. */
function present<T extends object>(value: T | null | undefined, keys: readonly (keyof T)[]): T | undefined {
  if (value === null || value === undefined) return undefined
  const kept = keys.flatMap((key) => (value[key] === null || value[key] === undefined ? [] : [[key, value[key]] as const]))
  return kept.length === 0 ? undefined : (Object.fromEntries(kept) as T)
}

function canonicalGeneric(generic: GenericCatalogSettings | null | undefined): GenericCatalogSettings | undefined {
  return present(generic, GENERIC_KEYS)
}

function canonicalRecipe(recipe: RecipeCatalogSettings | null | undefined): RecipeCatalogSettings | undefined {
  if (recipe === null || recipe === undefined) return undefined
  return present({ ...recipe, factors: present(recipe.factors, FACTOR_KEYS) }, RECIPE_KEYS)
}

/** The unified method as admitted, compared and sent: the defaults version and the set overrides, in option order. */
function canonicalUnified(preference: UnifiedCatalogPreference | null | undefined): UnifiedCatalogSettings {
  return present({ ...preference, defaults: UNIFIED_CATALOG_DEFAULTS_VERSION }, UNIFIED_KEYS)!
}

/** Saved settings as stored: an explicit Article in full, Catalog members only when they carry a value. */
export function canonicalExtractionSettings(settings: ExtractionSettings): ExtractionSettings {
  const generic = canonicalGeneric(settings.catalog?.generic)
  const recipe = canonicalRecipe(settings.catalog?.recipe)
  const unified = present(settings.catalog?.unified, UNIFIED_KEYS.slice(1) as readonly (keyof UnifiedCatalogPreference)[])
  return {
    ...(settings.article ? { article: canonicalArticle(settings.article) } : {}),
    ...(generic || recipe || unified
      ? { catalog: { ...(generic ? { generic } : {}), ...(recipe ? { recipe } : {}), ...(unified ? { unified } : {}) } }
      : {}),
  }
}

/** Legacy generic or recipe Catalog overrides the unified settings do not take over: they need an explicit migration. */
export function legacyCatalogOverrides(settings: ExtractionSettings): boolean {
  const catalog = canonicalExtractionSettings(settings).catalog
  return Boolean(catalog?.generic || catalog?.recipe)
}

/** The settings one Extraction uses, as it is compared, pinned and recorded. `null` records service defaults. */
export const activeSettingsSchema = z.union([
  z.object({ article: articleSettingsSchema.nullable() }).strict(),
  z.object({ generic: genericCatalogSettingsSchema.nullable() }).strict(),
  z.object({ recipe: recipeCatalogSettingsSchema.nullable() }).strict(),
  z.object({ unified: unifiedCatalogSettingsSchema }).strict(),
])
export type ActiveSettings = z.output<typeof activeSettingsSchema>
export type SettingsSlot = 'article' | 'generic' | 'recipe' | 'unified'

/** Article uses the Article member. A new Catalog Extraction uses the unified member where the deployment enables it;
 *  otherwise the legacy recipe member when a recipe is chosen, else the legacy generic member. */
export function settingsSlot(strategy: ExtractionStrategy, catalogRecipe: string | null, unified = false): SettingsSlot {
  return strategy === 'ARTICLE' ? 'article' : unified ? 'unified' : catalogRecipe ? 'recipe' : 'generic'
}

/** Whether `settings` is the member an Extraction of this strategy and recipe may carry: an admitted unified method has
 *  no recipe, whatever the deployment's current choice for new work. */
export function settingsFit(strategy: ExtractionStrategy, catalogRecipe: string | null, settings: object): boolean {
  return settingsSlot(strategy, catalogRecipe) in settings || (strategy === 'CATALOG' && !catalogRecipe && 'unified' in settings)
}

export function activeSettings(
  settings: ExtractionSettings, strategy: ExtractionStrategy, catalogRecipe: string | null, unified = false,
): ActiveSettings {
  const canonical = canonicalExtractionSettings(settings)
  switch (settingsSlot(strategy, catalogRecipe, unified)) {
    case 'article': return { article: canonical.article ?? null }
    case 'recipe': return { recipe: canonical.catalog?.recipe ?? null }
    case 'generic': return { generic: canonical.catalog?.generic ?? null }
    case 'unified': return { unified: canonicalUnified(canonical.catalog?.unified) }
  }
}

/** What a start view shows and submits, and what admission compares and pins: the Extraction Model Choice and the
 *  applicable saved settings. Never a key, a connection or a preset name. */
export const extractionMethodIntentSchema = z.object({
  models: extractionModelChoiceSchema.nullable(),
  settings: activeSettingsSchema,
}).strict()
export type ExtractionMethodIntent = Readonly<{ models: ExtractionModelChoice | null; settings: ActiveSettings }>

export function activeMethod(
  models: unknown, settings: ExtractionSettings, strategy: ExtractionStrategy, catalogRecipe: string | null, unified = false,
): ExtractionMethodIntent {
  return { models: modelChoice(models), settings: activeSettings(settings, strategy, catalogRecipe, unified) }
}

const accountMembersSchema = z.object({ extractionModels: extractionModelChoiceSchema, extractionSettings: extractionSettingsSchema })

/** The active method a stored account document (Studio's whole Model Configuration document, or null before its
 *  first Apply) gives one Extraction. Studio validates the document on every write, so one that fails here is refused,
 *  never read as defaults. */
export function accountMethod(
  document: unknown, strategy: ExtractionStrategy, catalogRecipe: string | null, unified = false,
): ExtractionMethodIntent {
  if (document === null) return activeMethod(null, {}, strategy, catalogRecipe, unified)
  const members = accountMembersSchema.safeParse(document)
  if (!members.success || extractionSettingsIssues(members.data.extractionSettings).length > 0)
    throw new ExtractionError('invalid_model_config', 'The saved model configuration is invalid.')
  // Retired character limits and recipe factors are never converted: the researcher applies the unified settings.
  if (unified && strategy === 'CATALOG' && legacyCatalogOverrides(members.data.extractionSettings))
    throw new ExtractionError('catalog_migration_required', METHOD_MESSAGES.migration)
  return activeMethod(members.data.extractionModels, members.data.extractionSettings, strategy, catalogRecipe, unified)
}

/** A submitted intent in the form admission compares, or null when it is malformed, breaks a rule, or names another
 *  strategy's settings. */
export function canonicalIntent(value: unknown, strategy: ExtractionStrategy, catalogRecipe: string | null): ExtractionMethodIntent | null {
  const parsed = extractionMethodIntentSchema.safeParse(value)
  if (!parsed.success || !settingsFit(strategy, catalogRecipe, parsed.data.settings)) return null
  const settings = parsed.data.settings as Partial<Record<SettingsSlot, unknown>>
  const slot = 'unified' in settings ? 'unified' : settingsSlot(strategy, catalogRecipe)
  const models = modelChoice(parsed.data.models)
  if (slot === 'unified') return { models, settings: { unified: canonicalUnified(settings.unified as UnifiedCatalogSettings) } }
  if (slot === 'article') {
    const article = settings.article as ArticleSettings | null
    if (article === null) return { models, settings: { article: null } }
    return articleSettingsIssues(article).length > 0 ? null : { models, settings: { article: canonicalArticle(article) } }
  }
  return {
    models,
    settings: slot === 'recipe'
      ? { recipe: canonicalRecipe(settings.recipe as RecipeCatalogSettings | null) ?? null }
      : { generic: canonicalGeneric(settings.generic as GenericCatalogSettings | null) ?? null },
  }
}

/** An Extraction's recorded settings: null for one admitted before they were recorded (it ran on service defaults). */
export function storedSettings(value: unknown, strategy: ExtractionStrategy, catalogRecipe: string | null): ActiveSettings | null {
  if (value === null || value === undefined) return null
  const parsed = activeSettingsSchema.safeParse(value)
  if (!parsed.success || !settingsFit(strategy, catalogRecipe, parsed.data))
    throw new ExtractionError('invalid_extraction_method', 'The admitted extraction method is invalid.')
  return parsed.data
}

/** The same stored method for reading and listing: a record a later contract no longer parses shows as not recorded, so
 *  one such row never breaks a whole listing. Execution uses `storedSettings`, which refuses it for that run only. */
export function recordedSettings(value: unknown, strategy: ExtractionStrategy, catalogRecipe: string | null): ActiveSettings | null {
  try {
    return storedSettings(value, strategy, catalogRecipe)
  } catch (error) {
    if (error instanceof ExtractionError && error.code === 'invalid_extraction_method') return null
    throw error
  }
}

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
  catalogRecipe: string | null
  requestedModels: ExtractionModelChoice | null
  /** The admitted settings; null for an Extraction admitted before they were recorded. */
  requestedSettings: ActiveSettings | null
}>

/** The method persisted on an Extraction: a recipe applies only to Catalog, and unchosen roles use service defaults. */
export function extractionMethod(
  strategy: ExtractionStrategy,
  catalogRecipe: string | null | undefined,
  requestedModels: unknown,
  requestedSettings?: unknown,
): ExtractionMethod {
  const recipe = strategy === 'CATALOG' ? catalogRecipe ?? null : null
  return {
    strategy,
    catalogRecipe: recipe,
    requestedModels: modelChoice(requestedModels),
    requestedSettings: storedSettings(requestedSettings, strategy, recipe),
  }
}

/** The Parsing Service's options for the same pinned method. Service defaults add nothing; an explicit Article is
 *  sent whole; generic Catalog limits are top-level options; recipe factors and budgets join the recipe; the unified
 *  Catalog is `unified`, its defaults version always included. */
export function keiMethodOptions(method: ExtractionMethod): Record<string, unknown> {
  const settings = method.requestedSettings
  const article = settings && 'article' in settings ? settings.article : null
  const generic = settings && 'generic' in settings ? settings.generic : null
  const recipe = settings && 'recipe' in settings ? settings.recipe : null
  const unified = settings && 'unified' in settings ? settings.unified : null
  return {
    strategy: method.strategy === 'CATALOG' ? 'catalog' : 'article',
    ...(method.requestedModels === null ? {} : { models: method.requestedModels }),
    ...(unified ? { unified: canonicalUnified(unified) } : {}),
    ...(method.strategy === 'ARTICLE' && article ? { article: canonicalArticle(article) } : {}),
    ...(method.strategy === 'CATALOG' && method.catalogRecipe === null && generic ? canonicalGeneric(generic) : {}),
    ...(method.catalogRecipe === null ? {} : { catalog: { recipe: method.catalogRecipe, ...(canonicalRecipe(recipe) ?? {}) } }),
  }
}

export type IdentityFieldIssue = Readonly<{ name: string; reason: 'missing' | 'nested' | 'not-scalar' | 'document' | 'filename' }>

/** Identity fields the pinned schema cannot key records by: absent, only nested, not a single value, or not read from
 *  the record (`valueSource`: the whole document, or the source's filename). Exact names, exact case. The Parsing
 *  Service checks the same at execution (`ExtractRequest._identity_fields_exist`); this refuses before anything is
 *  enqueued. */
export function identityFieldIssues(nodes: readonly SchemaNode[], fields: readonly string[]): IdentityFieldIssue[] {
  const topLevel = new Map(nodes.map((node) => [node.name, node]))
  const nested = new Set<string>()
  const visit = (node: SchemaNode): void => node.children?.forEach((child) => { nested.add(child.name); visit(child) })
  nodes.forEach(visit)
  return fields.flatMap((name): IdentityFieldIssue[] => {
    const node = topLevel.get(name)
    if (!node) return [{ name, reason: nested.has(name) ? 'nested' : 'missing' }]
    if (node.valueSource !== undefined) return [{ name, reason: node.valueSource === 'document' ? 'document' : 'filename' }]
    return isScalarFieldType(node.type) ? [] : [{ name, reason: 'not-scalar' }]
  })
}

const IDENTITY_REASONS: Readonly<Record<IdentityFieldIssue['reason'], string>> = {
  missing: 'not in this schema',
  nested: 'not a top-level field',
  'not-scalar': 'not a single value',
  document: 'read once for the whole document',
  filename: 'taken from the source’s filename',
}

export function identityFieldsMessage(issues: readonly IdentityFieldIssue[]): string {
  const named = issues.map(({ name, reason }) => `${name} (${IDENTITY_REASONS[reason]})`).join(', ')
  return `These identity fields are not scalar record fields of the selected Schema Revision: ${named}.`
}
