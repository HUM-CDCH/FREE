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

export const ARTICLE_SECTIONS: readonly { section: ArticleSection; title: string; keys: readonly ArticleKey[] }[] = [
  { section: 'context', title: 'Source context', keys: ['context', 'context_tokens', 'grouping', 'overlap_passages', 'selection'] },
  { section: 'identity', title: 'Record identity', keys: ['identity', 'identity_fields'] },
  { section: 'input', title: 'Extraction input', keys: ['prompt', 'rendering'] },
  { section: 'evidence', title: 'Evidence', keys: ['grounding', 'evidence_policy', 'grounding_schedule', 'grounding_routing'] },
]
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
  selection: 'Which units record-value calls read. Inventory, document fields and verification still visit every unit.',
  identity: 'Reference merges records by the model’s identity; declared fields key records by the fields you list.',
  identity_fields: 'Exact top-level scalar field names, checked against the schema when an Extraction starts.',
  prompt: 'Reference instructions include historical laboratory examples; schema-driven ones are built from the schema.',
  rendering: 'Structured input labels blocks and table cells. It keeps the source characters and cannot recover missing OCR text or cells.',
  grounding: 'How each populated record value is checked against the source.',
  evidence_policy: 'All populated record fields, or only those your schema policies mark quoted.',
  grounding_schedule: 'Across all source units keeps checking later units; it does not detect contradictions.',
  grounding_routing: 'Which units a value is checked against first. Unresolved values still reach every eligible unit.',
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
        ...(article.selection ? ['Supported units'] : []),
      ].join(' · ')
    case 'identity':
      return article.identity === 'conservative'
        ? `Declared identity fields: ${article.identity_fields.join(', ') || 'none'}`
        : article.identity_fields.length > 0 ? `Reference · fields: ${article.identity_fields.join(', ')}` : 'Reference'
    case 'input':
      return `${article.prompt === 'schema' ? 'Schema prompt' : 'Reference prompt'} · ${label('rendering', article.rendering)}`
    case 'evidence':
      return [
        label('grounding', article.grounding),
        article.evidence_policy ? 'Schema policies' : 'All fields',
        ...(article.grounding_schedule ? ['Until first support'] : []),
        ...(article.grounding_routing ? ['Origin and lexical order'] : []),
      ].join(' · ')
  }
}

const shownValue = (article: ArticleSettings, key: ArticleKey): string =>
  key === 'context_tokens'
    ? (article.context === 'bounded' ? `${numberText(article.context_tokens)} tokens` : 'Used with bounded source units')
    : key === 'identity_fields'
      ? (article.identity_fields.join(', ') || 'None')
      : label(key as keyof typeof ARTICLE_CHOICES, article[key])

/** Sections whose shown values differ from the saved settings (service defaults compare as the reference). */
export function changedSections(draft: ArticleSettings, saved: ArticleSettings | undefined): ReadonlySet<ArticleSection> {
  const before = saved ?? REFERENCE_ARTICLE
  return new Set(ARTICLE_KEYS.filter((key) => shownValue(draft, key) !== shownValue(before, key)).map((key) => SECTION_OF[key]))
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
      .filter((key) => shownValue(base, key) !== shownValue(after, key))
      .map((key) => ({ label: CONTROL_LABELS[key], from: shownValue(base, key), to: shownValue(after, key) })),
  ]
}

/** Which disclosure an issue opens: an Article section, or a Catalog one. */
export function issueSection(path: string): ArticleSection | 'generic' | 'recipe' | null {
  const [scope, member] = path.split('.')
  if (scope === 'article' && member) return SECTION_OF[member as ArticleKey] ?? null
  if (scope === 'catalog' && (member === 'generic' || member === 'recipe')) return member
  return null
}

const GENERIC_KEYS = ['discovery_chars', 'record_chars'] as const
const RECIPE_KEYS = ['input_tokens', 'output_tokens', 'factors'] as const

/** A Catalog draft in the contract's key order, without unset values; like `orderedArticle`, it never validates. */
export function orderedCatalog(catalog: Readonly<{ generic?: Record<string, unknown>; recipe?: Record<string, unknown> }>): CatalogSettings {
  const pick = (member: Record<string, unknown> | undefined, keys: readonly string[]) =>
    member && Object.fromEntries(keys.flatMap((key) => (member[key] === undefined ? [] : [[key, member[key]]])))
  const generic = pick(catalog.generic, GENERIC_KEYS)
  const recipe = pick(catalog.recipe, RECIPE_KEYS)
  return { ...(generic ? { generic } : {}), ...(recipe ? { recipe } : {}) } as CatalogSettings
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
  return orderedCatalog({ generic: member('generic'), recipe: member('recipe') })
}
