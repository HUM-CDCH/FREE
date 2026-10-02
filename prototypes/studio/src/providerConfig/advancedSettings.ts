import {
  ARTICLE_KEYS, articleSettingsIssues, METHOD_MESSAGES, REFERENCE_ARTICLE, REFERENCE_CATALOG, type ArticleSettings,
  type CatalogSettings,
} from 'extraction/extraction-method'

/** The Advanced tab's labels, one-line hints, summaries and availability. Local data and pure functions: the method
 *  rules themselves are the contract's (`articleSettingsIssues`); nothing here partitions tokens or checks evidence. */

export type AdvancedStrategy = 'article' | 'catalog'
export type ArticleKey = keyof ArticleSettings
export type ArticleSection = 'context' | 'identity' | 'input' | 'evidence'
export type CatalogFactor = 'glossary' | 'headings' | 'overlap' | 'verification'
export type NumberPath =
  | 'article.context_tokens'
  | 'catalog.generic.discovery_chars' | 'catalog.generic.record_chars'
  | 'catalog.recipe.input_tokens' | 'catalog.recipe.output_tokens'
  | 'catalog.unified.input_tokens' | 'catalog.unified.output_tokens' | 'catalog.unified.overlap'

export const ARTICLE_SECTIONS: readonly { section: ArticleSection; title: string; keys: readonly ArticleKey[] }[] = [
  { section: 'context', title: 'Source context', keys: ['context', 'context_tokens', 'grouping', 'overlap_passages', 'selection'] },
  { section: 'identity', title: 'Record identity', keys: ['identity', 'identity_fields'] },
  { section: 'input', title: 'Extraction input', keys: ['prompt', 'rendering'] },
  { section: 'evidence', title: 'Evidence', keys: ['grounding', 'evidence_policy', 'grounding_schedule', 'grounding_routing'] },
]
/** Settings today's Article method ignores. Article extracts one document-level object: it keeps no record-identity
 *  inventory (`identity`, `identity_fields`), its model requests do not change with `prompt`, and it reads every source
 *  unit for values (`selection`). Their controls stay visible but read-only, and a saved value is kept and sent as
 *  saved: the contract still accepts it, and historical settings are research state. */
export const RETIRED_ARTICLE_KEYS: ReadonlySet<ArticleKey> = new Set([
  'selection', 'identity', 'identity_fields', 'prompt', 'grounding_schedule', 'grounding_routing',
])
/** Said beside every retired control. */
export const RETIRED_NOTE = 'No longer used by Article. A saved value is kept unchanged.'

export const SECTION_OF = Object.fromEntries(
  ARTICLE_SECTIONS.flatMap(({ section, keys }) => keys.map((key) => [key, section])),
) as Readonly<Record<ArticleKey, ArticleSection>>

export const CONTROL_LABELS: Readonly<Record<ArticleKey, string>> = {
  context: 'Scope', context_tokens: 'Context ceiling', grouping: 'Grouping', overlap_passages: 'Previous passages',
  selection: 'Value evidence', identity: 'Reconciliation', identity_fields: 'Identity fields', prompt: 'Instructions',
  rendering: 'Source representation', grounding: 'Verification', evidence_policy: 'Fields to verify',
  grounding_schedule: 'Continue verification', grounding_routing: 'Unit order',
}

export const CONTROL_HINTS: Readonly<Record<ArticleKey, string>> = {
  context: 'Full source reads the whole document at once; bounded source units split it into parts that fit a ceiling.',
  context_tokens: 'Tokens per request, including instructions and the output reserve; each served model can lower it.',
  grouping: 'How bounded units are formed: by token budget, or following headings, captions and tables.',
  overlap_passages: 'Whole earlier passages repeated as context. They never own records; not pages or sentences.',
  selection: 'Article now reads every source unit for values, so this choice no longer changes what is read.',
  identity: 'Article now extracts one document-level object, so there are no records to reconcile.',
  identity_fields: 'Article now extracts one document-level object, so no fields key records.',
  prompt: 'Article’s model requests no longer change with this choice.',
  rendering: 'Structured input labels blocks and table cells. It keeps the source characters and cannot recover missing OCR text or cells.',
  grounding: 'How each populated record value is checked against the source.',
  evidence_policy: 'All populated record fields, or only those your schema policies mark quoted.',
  grounding_schedule: 'Article now checks each value where it was read first and stops at support, whichever is chosen.',
  grounding_routing: 'Article now checks each value in the source unit it was read from first, whichever is chosen.',
}

type Choice<V> = Readonly<{ value: V; label: string }>
export const ARTICLE_CHOICES = {
  context: [{ value: 'full', label: 'Full source' }, { value: 'bounded', label: 'Bounded source units' }],
  grouping: [{ value: undefined, label: 'Token budget' }, { value: 'structural', label: 'Structure-aware' }],
  overlap_passages: [{ value: 0, label: '0' }, { value: 1, label: '1' }, { value: 2, label: '2' }],
  selection: [{ value: undefined, label: 'All source units' }, { value: 'supported', label: 'Supported units' }],
  identity: [{ value: 'reference', label: 'Reference' }, { value: 'conservative', label: 'Declared identity fields' }],
  prompt: [{ value: 'reference', label: 'Reference' }, { value: 'schema', label: 'Schema-driven' }],
  rendering: [{ value: undefined, label: 'Plain text' }, { value: 'structured', label: 'Structured blocks and tables' }],
  grounding: [
    { value: 'semantic', label: 'Source labels' }, { value: 'quoted', label: 'Generated quotes' },
    { value: 'spans', label: 'Source spans' }, { value: 'off', label: 'Off' },
  ],
  evidence_policy: [{ value: undefined, label: 'All populated record fields' }, { value: 'schema', label: 'Follow schema policies' }],
  grounding_schedule: [{ value: undefined, label: 'Across all source units' }, { value: 'unresolved', label: 'Until first support' }],
  grounding_routing: [{ value: undefined, label: 'Source order' }, { value: 'origin_lexical', label: 'Origin and lexical relevance' }],
} as const satisfies { [K in Exclude<ArticleKey, 'context_tokens' | 'identity_fields'>]: readonly Choice<ArticleSettings[K] | undefined>[] }

export const CATALOG_LABELS = {
  discovery_chars: 'Discovery text limit', record_chars: 'Record text limit',
  input_tokens: 'Input budget', output_tokens: 'Output reserve',
  glossary: 'Glossary', headings: 'Inherited headings', overlap: 'Neighboring context', verification: 'Verification',
} as const

export const NUMBER_MESSAGES: Readonly<Record<NumberPath, string>> = {
  'article.context_tokens': METHOD_MESSAGES.contextTokens,
  'catalog.generic.discovery_chars': METHOD_MESSAGES.characters,
  'catalog.generic.record_chars': METHOD_MESSAGES.characters,
  'catalog.recipe.input_tokens': METHOD_MESSAGES.budgetTokens,
  'catalog.recipe.output_tokens': METHOD_MESSAGES.budgetTokens,
  'catalog.unified.input_tokens': METHOD_MESSAGES.inputTokens,
  'catalog.unified.output_tokens': METHOD_MESSAGES.replyTokens,
  'catalog.unified.overlap': METHOD_MESSAGES.catalogOverlap,
}

/** Rebuilds an Article draft in `ArticleOptions` order without unset factors, so equal drafts serialize alike. */
export function orderedArticle(article: Readonly<Partial<Record<ArticleKey, unknown>>>): ArticleSettings {
  return Object.fromEntries(ARTICLE_KEYS.flatMap((key) =>
    article[key] === undefined || article[key] === null ? [] : [[key, article[key]]])) as ArticleSettings
}

/** Why choosing `value` would break a rule at this very control, or null. A parent choice that breaks a child stays
 *  available (the child is kept and shown invalid); the choice already selected is never disabled. */
export function unavailableReason<K extends ArticleKey>(article: ArticleSettings, key: K, value: ArticleSettings[K] | undefined): string | null {
  if (article[key] === value) return null
  const issue = articleSettingsIssues(orderedArticle({ ...article, [key]: value })).find((candidate) => candidate.path === key)
  return issue?.message ?? null
}

const numberText = (value: number) => value.toLocaleString('en-US')
const VERIFICATION: Readonly<Record<ArticleSettings['grounding'], string>> = {
  semantic: 'Source-label verification', quoted: 'Generated-quote verification', spans: 'Source-span verification', off: 'No verification',
}
const label = <K extends keyof typeof ARTICLE_CHOICES>(key: K, value: unknown) =>
  ARTICLE_CHOICES[key].find((choice) => choice.value === (value ?? undefined))!.label

/** The one line under "Settings for"; service defaults read as the documented reference. */
export function effectiveSummary(article: ArticleSettings | undefined): string {
  const shown = article ?? REFERENCE_ARTICLE
  const scope = shown.context === 'bounded' ? `Bounded source units (${numberText(shown.context_tokens)} tokens)` : 'Full source'
  return [scope, label('rendering', shown.rendering), VERIFICATION[shown.grounding]].join(' · ')
}

/** A collapsed row's value, derived from the draft; inactive values are left out. */
export function sectionSummary(article: ArticleSettings, section: ArticleSection): string {
  switch (section) {
    case 'context':
      return article.context === 'full' ? 'Full source' : [
        'Bounded', `${numberText(article.context_tokens)} tokens`,
        ...(article.grouping ? ['Structure-aware'] : []),
        ...(article.overlap_passages > 0 ? [`${article.overlap_passages} previous passage${article.overlap_passages === 1 ? '' : 's'}`] : []),
      ].join(' · ')
    // Retired settings (`RETIRED_ARTICLE_KEYS`) are left out: they no longer describe what Article does.
    case 'identity':
      return 'Not used by Article'
    case 'input':
      return label('rendering', article.rendering)
    case 'evidence':
      return [
        label('grounding', article.grounding),
        article.evidence_policy ? 'Schema policies' : 'All fields',
      ].join(' · ')
  }
}

/** A setting's value as a researcher reads it; the unused ceiling says so. */
export const describeArticleValue = (article: ArticleSettings, key: ArticleKey): string =>
  key === 'context_tokens'
    ? (article.context === 'bounded' ? `${numberText(article.context_tokens)} tokens` : 'Used with bounded source units')
    : key === 'identity_fields'
      ? (article.identity_fields.join(', ') || 'None')
      : label(key as keyof typeof ARTICLE_CHOICES, article[key])

/** Sections whose shown values differ from the saved settings (service defaults compare as the reference). */
export function changedSections(draft: ArticleSettings, saved: ArticleSettings | undefined): ReadonlySet<ArticleSection> {
  const before = saved ?? REFERENCE_ARTICLE
  return new Set(ARTICLE_KEYS.filter((key) => describeArticleValue(draft, key) !== describeArticleValue(before, key)).map((key) => SECTION_OF[key]))
}

export type StartingPoint = Readonly<{ name: string; description: string; assign: Readonly<Partial<Record<ArticleKey, unknown>>> }>

/** Design §6: two transparent assignments, not recommendations. Identity fields are never assigned. */
export const STARTING_POINTS: readonly StartingPoint[] = [
  {
    name: 'Reference controls',
    description: 'Explicit full source, reference identity and prompt, plain input, source-label verification and no optional factors. A current-runtime reference configuration, not an exact reproduction of historical R1 v11.',
    assign: {
      context: 'full', context_tokens: 12288, overlap_passages: 0, grouping: undefined, selection: undefined, identity: 'reference',
      prompt: 'reference', rendering: undefined, grounding: 'semantic', evidence_policy: undefined, grounding_schedule: undefined,
      grounding_routing: undefined,
    },
  },
  {
    name: 'Explore spans and schema policies',
    description: 'Explicit bounded 12,288, no previous passages, token grouping, all value units, reference identity, schema prompt, plain input, source spans, schema policies, until first support and source order. It explores the combined method family. It is not a recommendation, a speed claim or a pilot reproduction.',
    assign: {
      context: 'bounded', context_tokens: 12288, overlap_passages: 0, grouping: undefined, selection: undefined, identity: 'reference',
      prompt: 'schema', rendering: undefined, grounding: 'spans', evidence_policy: 'schema', grounding_schedule: 'unresolved',
      grounding_routing: undefined,
    },
  },
]

export function withStartingPoint(article: ArticleSettings | undefined, point: StartingPoint): ArticleSettings {
  return orderedArticle({ ...(article ?? REFERENCE_ARTICLE), ...point.assign })
}

export type SettingChange = Readonly<{ label: string; from: string; to: string }>

/** Every setting a change would alter, in control order, as the researcher reads them. */
export function settingsDelta(before: ArticleSettings | undefined, after: ArticleSettings): readonly SettingChange[] {
  const base = before ?? REFERENCE_ARTICLE
  return [
    ...(before ? [] : [{ label: 'Article settings', from: 'Service defaults', to: 'Customized' }]),
    ...ARTICLE_SECTIONS.flatMap(({ keys }) => keys)
      .filter((key) => describeArticleValue(base, key) !== describeArticleValue(after, key))
      .map((key) => ({ label: CONTROL_LABELS[key], from: describeArticleValue(base, key), to: describeArticleValue(after, key) })),
  ]
}

/** Which disclosure an issue opens: an Article section, or a Catalog one. */
export function issueSection(path: string): ArticleSection | 'generic' | 'recipe' | 'unified' | null {
  const [scope, member] = path.split('.')
  if (scope === 'article' && member) return SECTION_OF[member as ArticleKey] ?? null
  if (scope === 'catalog' && (member === 'generic' || member === 'recipe' || member === 'unified')) return member
  return null
}

const GENERIC_KEYS = ['discovery_chars', 'record_chars'] as const
const RECIPE_KEYS = ['input_tokens', 'output_tokens', 'factors'] as const
const UNIFIED_KEYS = ['input_tokens', 'output_tokens', 'overlap', 'headings', 'verification'] as const

/** A Catalog draft in the contract's key order, without unset values; like `orderedArticle`, it never validates. */
export function orderedCatalog(catalog: Readonly<{ generic?: Record<string, unknown>; recipe?: Record<string, unknown>; unified?: Record<string, unknown> }>): CatalogSettings {
  const pick = (member: Record<string, unknown> | undefined, keys: readonly string[]) =>
    member && Object.fromEntries(keys.flatMap((key) => (member[key] === undefined ? [] : [[key, member[key]]])))
  const generic = pick(catalog.generic, GENERIC_KEYS)
  const recipe = pick(catalog.recipe, RECIPE_KEYS)
  const unified = pick(catalog.unified, UNIFIED_KEYS)
  return { ...(generic ? { generic } : {}), ...(recipe ? { recipe } : {}), ...(unified ? { unified } : {}) } as CatalogSettings
}

/** A Catalog edit that returns a value the saved override omits to the value shown for it (the service default)
 *  omits it again, and a member left empty that way goes too: toggling or typing back is not an unsaved change. Values
 *  the saved override sets stay explicit; without a saved override (Customize), nothing is omitted. */
export function keepSavedOmissions(catalog: CatalogSettings, saved: CatalogSettings | undefined): CatalogSettings {
  if (!saved) return catalog
  const member = (name: 'generic' | 'recipe') => {
    const edited = catalog[name] as Record<string, unknown> | undefined
    const before = saved[name] as Record<string, unknown> | undefined
    const shown = REFERENCE_CATALOG[name] as Record<string, unknown>
    if (!edited) return undefined
    const kept = Object.fromEntries(Object.entries(edited).filter(([key, value]) =>
      before?.[key] !== undefined || JSON.stringify(value) !== JSON.stringify(shown[key])))
    return Object.keys(kept).length === 0 && before === undefined ? undefined : kept
  }
  return orderedCatalog({ generic: member('generic'), recipe: member('recipe'), unified: catalog.unified })
}
