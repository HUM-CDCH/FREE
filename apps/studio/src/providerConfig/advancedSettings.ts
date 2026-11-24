import {
  ARTICLE_KEYS, articleSettingsIssues, METHOD_MESSAGES, REFERENCE_ARTICLE, type ArticleSettings,
  type CatalogSettings, UNIFIED_PREFERENCE_KEYS,
} from 'extraction/extraction-method'

/** The Advanced tab's labels, one-line hints, summaries and availability. Local data and pure functions: the method
 *  rules themselves are the contract's (`articleSettingsIssues`); nothing here partitions tokens or checks evidence. */

export type AdvancedStrategy = 'article' | 'catalog'
export type ArticleKey = keyof ArticleSettings
export type ArticleSection = 'context' | 'input' | 'evidence'
export type NumberPath =
  | 'article.context_tokens'
  | 'catalog.unified.input_tokens' | 'catalog.unified.output_tokens' | 'catalog.unified.overlap' | 'catalog.unified.candidates'

export const ARTICLE_SECTIONS: readonly { section: ArticleSection; title: string; keys: readonly ArticleKey[] }[] = [
  { section: 'context', title: 'Source context', keys: ['context', 'context_tokens', 'grouping', 'overlap_passages'] },
  { section: 'input', title: 'Extraction input', keys: ['rendering'] },
  { section: 'evidence', title: 'Evidence', keys: ['grounding', 'grounding_overflow', 'evidence_policy'] },
]

export const SECTION_OF = Object.fromEntries(
  ARTICLE_SECTIONS.flatMap(({ section, keys }) => keys.map((key) => [key, section])),
) as Readonly<Record<ArticleKey, ArticleSection>>

export const CONTROL_LABELS: Readonly<Record<ArticleKey, string>> = {
  context: 'Scope', context_tokens: 'Context ceiling', grouping: 'Grouping', overlap_passages: 'Previous passages',
  rendering: 'Source representation', grounding: 'Verification', grounding_overflow: 'Large checks',
  evidence_policy: 'Fields to verify',
}

export const CONTROL_HINTS: Readonly<Record<ArticleKey, string>> = {
  context: 'Full source reads the whole document at once; bounded source units split it into parts that fit a ceiling.',
  context_tokens: 'Tokens per request, including instructions and the output reserve; each served model can lower it.',
  grouping: 'How bounded units are formed: by token budget, or following headings, captions and tables.',
  overlap_passages: 'Whole earlier passages repeated as context. They never own records; not pages or sentences.',
  rendering: 'Structured input labels blocks and table cells. It keeps the source characters and cannot recover missing OCR text or cells.',
  grounding: 'How each populated record value is checked against the source.',
  grounding_overflow: 'A value whose check with its whole source unit is too large: checked in halves of that unit, or left unchecked.',
  evidence_policy: 'All populated record fields, or only those your template policies mark quoted.',
}

type Choice<V> = Readonly<{ value: V; label: string }>
export const ARTICLE_CHOICES = {
  context: [{ value: 'full', label: 'Full source' }, { value: 'bounded', label: 'Bounded source units' }],
  grouping: [{ value: undefined, label: 'Token budget' }, { value: 'structural', label: 'Structure-aware' }],
  overlap_passages: [{ value: 0, label: '0' }, { value: 1, label: '1' }, { value: 2, label: '2' }],
  rendering: [{ value: undefined, label: 'Plain text' }, { value: 'structured', label: 'Structured blocks and tables' }],
  grounding: [
    { value: 'semantic', label: 'Source labels' }, { value: 'quoted', label: 'Generated quotes' },
    { value: 'spans', label: 'Source spans' }, { value: 'off', label: 'Off' },
  ],
  grounding_overflow: [{ value: undefined, label: 'Leave unchecked' }, { value: 'windows', label: 'Check in windows' }],
  evidence_policy: [{ value: undefined, label: 'All populated record fields' }, { value: 'schema', label: 'Follow template policies' }],
} as const satisfies { [K in Exclude<ArticleKey, 'context_tokens'>]: readonly Choice<ArticleSettings[K] | undefined>[] }

export const NUMBER_MESSAGES: Readonly<Record<NumberPath, string>> = {
  'article.context_tokens': METHOD_MESSAGES.contextTokens,
  'catalog.unified.input_tokens': METHOD_MESSAGES.inputTokens,
  'catalog.unified.output_tokens': METHOD_MESSAGES.replyTokens,
  'catalog.unified.overlap': METHOD_MESSAGES.catalogOverlap,
  'catalog.unified.candidates': METHOD_MESSAGES.catalogCandidates,
}

/** Rebuilds an Article draft in `ArticleOptions` order without unset factors, so equal drafts serialize alike. */
export function orderedArticle(article: Readonly<Partial<Record<ArticleKey, unknown>>>): ArticleSettings {
  return Object.fromEntries(ARTICLE_KEYS.flatMap((key) =>
    article[key] === undefined || article[key] === null ? [] : [[key, article[key]]])) as ArticleSettings
}

/** Why choosing `value` would break a rule at this very control, or null. A parent choice that breaks a child stays
 *  available (the child is kept and shown invalid, except large checks, which verification off clears: `setArticle`);
 *  the choice already selected is never disabled. */
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

/** The one line under "Settings for"; service defaults read as Studio's (`REFERENCE_ARTICLE`, with windows). */
export function effectiveSummary(article: ArticleSettings | undefined): string {
  const shown = article ?? REFERENCE_ARTICLE
  const scope = shown.context === 'bounded' ? `Bounded source units (${numberText(shown.context_tokens)} tokens)` : 'Full source'
  return [scope, label('rendering', shown.rendering), VERIFICATION[shown.grounding],
    ...(shown.grounding_overflow ? ['Large checks in windows'] : [])].join(' · ')
}

/** A setting's value as a researcher reads it; the unused ceiling says so. */
export const describeArticleValue = (article: ArticleSettings, key: ArticleKey): string =>
  key === 'context_tokens'
    ? (article.context === 'bounded' ? `${numberText(article.context_tokens)} tokens` : 'Used with bounded source units')
    : label(key as keyof typeof ARTICLE_CHOICES, article[key])

/** Sections whose shown values differ from the saved settings (service defaults compare as `REFERENCE_ARTICLE`). */
export function changedSections(draft: ArticleSettings, saved: ArticleSettings | undefined): ReadonlySet<ArticleSection> {
  const before = saved ?? REFERENCE_ARTICLE
  return new Set(ARTICLE_KEYS.filter((key) => describeArticleValue(draft, key) !== describeArticleValue(before, key)).map((key) => SECTION_OF[key]))
}

export type StartingPoint = Readonly<{ name: string; description: string; assign: Readonly<Partial<Record<ArticleKey, unknown>>> }>

/** Design §6: two transparent assignments, not recommendations. Identity fields are never assigned. */
export const STARTING_POINTS: readonly StartingPoint[] = [
  {
    name: 'Reference controls',
    description: 'The service defaults, explicit: full source, plain input, source-label verification, large checks in windows and no other optional factor.',
    assign: {
      context: 'full', context_tokens: 12288, overlap_passages: 0, grouping: undefined, rendering: undefined, grounding: 'semantic', evidence_policy: undefined, grounding_overflow: 'windows',
    },
  },
  {
    name: 'Explore spans and template policies',
    description: 'Explicit bounded 12,288, no previous passages, token grouping, plain input, source spans and template policies. It explores the combined method family. It is not a recommendation, a speed claim or a pilot reproduction.',
    assign: {
      context: 'bounded', context_tokens: 12288, overlap_passages: 0, grouping: undefined, rendering: undefined, grounding: 'spans', evidence_policy: 'schema', grounding_overflow: undefined,
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

/** A Catalog draft in contract order, without unset values; validation is the contract's. */
export function orderedCatalog(catalog: Readonly<{ unified?: Record<string, unknown> }>): CatalogSettings {
  const member = catalog.unified
  return member ? { unified: Object.fromEntries(UNIFIED_PREFERENCE_KEYS.flatMap(key => member[key] === undefined ? [] : [[key, member[key]]])) } : {}
}
