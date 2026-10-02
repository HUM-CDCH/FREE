import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import {
  CATALOG_DEFAULTS, extractionMethod, keiMethodOptions, REFERENCE_ARTICLE, UNIFIED_CATALOG_DEFAULTS,
  UNIFIED_CATALOG_DEFAULTS_VERSION, type ArticleSettings, type CatalogSettings,
} from 'extraction/extraction-method'
import { settingsHeadline, UNIFIED_LABELS, unifiedLines } from '../methodSummary'
import type { ModelConfig } from '../../shared/modelConfig.contract'
import { ExplainButton, GuideProvider, HowThisWorksButton } from './AdvancedGuide'
import { SECTION_TOPIC, type GuideTopicId } from './advancedGuide.data'
import {
  ARTICLE_CHOICES, ARTICLE_SECTIONS, CATALOG_LABELS, CONTROL_HINTS, CONTROL_LABELS, changedSections, effectiveSummary,
  unavailableReason, type AdvancedStrategy, type ArticleKey,
  type ArticleSection, type CatalogFactor, type NumberPath,
} from './advancedSettings'
import type { ProviderConfigDraft } from './useProviderConfigDraft'
import { SettingsViews } from './SettingsViews'

export type AdvancedEditor = Pick<ProviderConfigDraft,
  'customize' | 'useServiceDefaults' | 'setArticle' | 'replaceArticle' | 'addIdentityField' | 'removeIdentityField' |
  'setCatalogFactor' | 'customizeUnified' | 'setUnified' | 'setNumber' | 'numberEdits' | 'settingsIssues'>

type Props = {
  draft: ModelConfig
  saved: ModelConfig
  editor: AdvancedEditor
  /** Set by the footer's issue summary: show the first issue's section, focus its control, then report it handled. */
  focusIssue: boolean
  onIssueFocused: () => void
  /** The deployment admits new Catalog Extractions on the unified method: its one group replaces Generic and Recipe. */
  unifiedCatalog?: boolean
}

/** The starting point last used, and the Article draft (with its number text) that Undo restores. `shown` is the
 *  Article draft the starting point produced, recorded on the first render that has it. */
type Applied = Readonly<{
  name: string; prior: ArticleSettings | undefined; priorEdits: ProviderConfigDraft['numberEdits']
  shown?: Readonly<{ article: ArticleSettings | undefined; edits: string }>
}>

const STRATEGIES: readonly { value: AdvancedStrategy; label: string }[] = [
  { value: 'article', label: 'Article' }, { value: 'catalog', label: 'Catalog' },
]
const textButton = 'text-[11.5px] font-semibold transition-colors'
const describedBy = (...ids: readonly (string | false | null)[]) => ids.filter(Boolean).join(' ')
const articleEdits = (edits: ProviderConfigDraft['numberEdits']) =>
  JSON.stringify(Object.entries(edits).filter(([path]) => path.startsWith('article.')))
/** Explain stays outside the controls' fieldset, so it also works while service defaults are in use. */
const explain = (topic: GuideTopicId, subject: string) => (
  <div className="flex justify-end"><ExplainButton topic={topic} subject={subject} /></div>
)

/** Inspect nested request options one value at a time without a long JSON panel. */
function requestEntries(value: unknown, path = ''): [string, unknown][] {
  if (value !== null && typeof value === 'object' && Object.keys(value).length > 0) {
    return Object.entries(value).flatMap(([key, item]) => requestEntries(item, path ? `${path}.${key}` : key))
  }
  return [[path, value]]
}

/** Saved method settings for future Extractions, per strategy, in the page's one draft. Choosing which strategy's
 *  settings to edit never changes any Extraction's strategy. */
export function AdvancedTab({ draft, saved, editor, focusIssue, onIssueFocused, unifiedCatalog = false }: Props) {
  const [strategy, setStrategy] = useState<AdvancedStrategy>('article')
  const root = useRef<HTMLElement>(null)
  const guideTrigger = useRef<HTMLButtonElement>(null)
  const headingId = useId()
  const [applied, setApplied] = useState<Applied | null>(null)
  // Discard and Apply make the draft the saved document again (the same object): that ends the notice and its Undo.
  if (applied && draft === saved) setApplied(null)
  // It also ends at the first Article edit after it (settings, identity fields or number text), for good: an Undo
  // shown again later would discard the edits made in between.
  const current = { article: draft.extractionSettings.article, edits: articleEdits(editor.numberEdits) }
  if (applied && !applied.shown) setApplied({ ...applied, shown: current })
  else if (applied?.shown && (applied.shown.article !== current.article || applied.shown.edits !== current.edits)) setApplied(null)
  const notice = applied && (!applied.shown || applied.shown.article === current.article) ? applied : null
  const first = editor.settingsIssues[0]
  const issueStrategy: AdvancedStrategy | null = first ? (first.path.startsWith('catalog.') ? 'catalog' : 'article') : null
  // The footer's request shows the first issue's strategy before anything is committed.
  if (focusIssue && issueStrategy && issueStrategy !== strategy) setStrategy(issueStrategy)
  const unifiedView = strategy === 'catalog' && unifiedCatalog
  const custom = unifiedView ? draft.extractionSettings.catalog?.unified !== undefined : draft.extractionSettings[strategy] !== undefined

  // Committed with that strategy's view, whose issue section is forced open: its control can take focus.
  useEffect(() => {
    if (!focusIssue) return
    if (first) root.current?.querySelector<HTMLElement>(`[data-setting="${first.path}"]`)?.focus()
    onIssueFocused()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per request from the footer
  }, [focusIssue])

  // After "Use these settings" the guide returns focus to its trigger; when that trigger left with the Catalog view,
  // focus stays on "How this works", beside the notice, instead of being lost.
  useEffect(() => {
    if (applied) guideTrigger.current?.focus()
  }, [applied])

  /** Only the Article draft changes: Models, Connections and Catalog stay; Apply still saves. */
  function draftStartingPoint(article: ArticleSettings, name: string): void {
    setApplied({ name, prior: draft.extractionSettings.article, priorEdits: editor.numberEdits })
    editor.replaceArticle(article)
    setStrategy('article')
  }

  function undo(restored: Applied): void {
    editor.replaceArticle(restored.prior, restored.priorEdits)
    setApplied(null)
    guideTrigger.current?.focus()
  }

  return (
    <GuideProvider article={draft.extractionSettings.article} onUseSettings={draftStartingPoint}>
      <section ref={root} aria-labelledby={headingId} className="configuration-view advanced-settings flex min-w-0 flex-col gap-2 p-3 sm:p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id={headingId} className="text-[13px] font-bold text-ink">Advanced extraction</h3>
          <HowThisWorksButton triggerRef={guideTrigger} />
        </div>
        <p className="-mt-2 text-[11.5px] text-ink-faint">Applies to new Extractions in your Projects.</p>
        <div className="flex flex-wrap items-center justify-between gap-2">
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="sr-only">Settings for</legend>
          <span aria-hidden="true" className="text-[11.5px] font-semibold text-ink-muted">Settings for:</span>
          {STRATEGIES.map((option) => (
            <label key={option.value} className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[12px] text-ink">
              <input type="radio" name={`${headingId}-strategy`} checked={strategy === option.value} onChange={() => setStrategy(option.value)} />
              {option.label}
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={!custom}
            className={`${textButton} rounded-md border border-line px-2.5 py-1 ${custom ? 'text-ink-muted hover:text-accent' : 'bg-surface-muted text-ink'}`}
            onClick={() => editor.useServiceDefaults(strategy)}>Use service defaults</button>
          <button type="button" aria-pressed={custom}
            className={`${textButton} rounded-md border border-line px-2.5 py-1 ${custom ? 'bg-surface-muted text-ink' : 'text-accent hover:underline'}`}
            onClick={() => { if (custom) return; if (unifiedView) editor.customizeUnified(); else editor.customize(strategy) }}>Customize</button>
        </div>
        </div>
        <div>
          {/* Always rendered, so the notice is announced when it appears. */}
          <div role="status">
            {notice && (
              <p className="mt-1.5 flex flex-wrap items-baseline gap-2 text-[11.5px] text-ink">
                {`Settings from “${notice.name}” are in your draft. Apply saves them.`}
                <button type="button" className={`${textButton} text-accent hover:underline`} onClick={() => undo(notice)}>Undo</button>
              </p>
            )}
          </div>
        </div>
        {strategy === 'article'
          ? <ArticleSettingsView draft={draft} saved={saved} editor={editor} focusIssue={focusIssue} />
          : unifiedView
            ? <UnifiedCatalogView draft={draft} saved={saved} editor={editor} focusIssue={focusIssue} />
            : <CatalogSettingsView draft={draft} saved={saved} editor={editor} focusIssue={focusIssue} />}
      </section>
    </GuideProvider>
  )
}

function ArticleSettingsView({ draft, saved, editor, focusIssue }: Pick<Props, 'draft' | 'saved' | 'editor' | 'focusIssue'>) {
  const explicit = draft.extractionSettings.article
  const custom = explicit !== undefined
  const article = explicit ?? REFERENCE_ARTICLE
  const changed = changedSections(article, saved.extractionSettings.article)
  const issueAt = (key: ArticleKey) => editor.settingsIssues.find((issue) => issue.path === `article.${key}`)?.message ?? null
  const choice = (key: keyof typeof ARTICLE_CHOICES) => (
    <ChoiceGroup key={key} settingKey={key} article={article} custom={custom} error={issueAt(key)}
      onChange={(value) => editor.setArticle(key, value)} />
  )
  const controls: Readonly<Record<ArticleSection, ReactNode[]>> = {
    context: [
      choice('context'),
      <NumberField key="context_tokens" path="article.context_tokens" label={CONTROL_LABELS.context_tokens} hint={CONTROL_HINTS.context_tokens}
        unit="tokens, at least 8,192" value={article.context_tokens} edit={editor.numberEdits['article.context_tokens']}
        disabled={!custom} inactive={article.context === 'full'} error={issueAt('context_tokens')} onText={editor.setNumber} />,
      choice('grouping'), choice('overlap_passages'), choice('selection'),
    ],
    identity: [
      choice('identity'),
      <IdentityFields key="identity_fields" fields={article.identity_fields} custom={custom} error={issueAt('identity_fields')}
        add={editor.addIdentityField} remove={editor.removeIdentityField} />,
    ],
    input: [choice('prompt'), choice('rendering')],
    evidence: [choice('grounding'), choice('evidence_policy'), choice('grounding_schedule'), choice('grounding_routing')],
  }
  const issue = focusIssue ? editor.settingsIssues.find((item) => item.path.startsWith('article.')) : undefined
  const issueKey = issue?.path.slice('article.'.length) as ArticleKey | undefined
  const pages = ARTICLE_SECTIONS.flatMap(({ section, title, keys }) => keys.map((key, at) => ({
    title: `${title}: ${CONTROL_LABELS[key]}`,
    key,
    content: <section key={key} aria-label={title} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-[12px] font-semibold text-ink">{title}</h4>
        {changed.has(section) && <span className="text-[10.5px] font-semibold text-accent">Changed</span>}
        {explain(SECTION_TOPIC[section], title)}
      </div>
      <fieldset disabled={!custom}>{controls[section][at]}</fieldset>
      {key === 'grounding' && <p className="text-[11px] text-ink-faint">Article document-level fields currently remain unverified.</p>}
    </section>,
  })))
  const options = editor.settingsIssues.some((item) => item.path.startsWith('article.')) ? null :
    keiMethodOptions(extractionMethod('ARTICLE', null, draft.extractionModels, { article: explicit ?? null }))
  const entries = options ? requestEntries(options) : []
  return (
    <SettingsViews label="Article setting" titles={[...pages.map((page) => page.title), 'Effective settings', 'Technical details']}
      selected={pages.find((page) => page.key === issueKey)?.title}>
      {pages.map((page) => page.content)}
      <section className="flex flex-col gap-2">
        <h4 className="text-[12px] font-semibold text-ink">Effective settings</h4>
        <p className="text-[12px] text-ink">{effectiveSummary(explicit)}</p>
        {!custom && <p className="text-[11.5px] text-ink-muted">Service defaults; resolved for the Extraction using each served model’s context size.</p>}
        <p className="text-[11.5px] text-ink-muted">Field and reasoning models follow the Models tab: field values {draft.extractionModels.fields ?? 'deployment default'}, reasoning {draft.extractionModels.reasoning ?? 'deployment default'}.</p>
      </section>
      <section className="text-[11px] text-ink-muted">
        {!options ? <p>Fix the issues above to preview the request.</p> :
          <SettingsViews label="Request option" titles={entries.map(([key]) => key)}>
            {entries.map(([key, value]) => <div key={key}><h4 className="font-semibold">{key}</h4><pre className="mt-1 whitespace-pre-wrap break-all font-mono">{JSON.stringify(value, null, 2)}</pre></div>)}
          </SettingsViews>}
      </section>
    </SettingsViews>
  )
}

/** Always rendered, so a message that appears in it is announced. */
function FieldError({ id, message }: { id: string; message: string | null }) {
  return <p id={id} aria-live="polite" className="text-[11px] font-semibold text-danger">{message}</p>
}

function ChoiceGroup<K extends keyof typeof ARTICLE_CHOICES>({ settingKey, article, custom, error, onChange }: {
  settingKey: K; article: ArticleSettings; custom: boolean; error: string | null; onChange: (value: ArticleSettings[K] | undefined) => void
}) {
  const id = useId()
  // One key's choices; the cast only names the element type the `as const` table already has for this key.
  const options = ARTICLE_CHOICES[settingKey] as readonly Readonly<{ value: ArticleSettings[K] | undefined; label: string }>[]
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className="text-[11px] font-semibold text-ink-muted">{CONTROL_LABELS[settingKey]}</legend>
      <p id={`${id}-hint`} className="text-[10.5px] text-ink-faint">{CONTROL_HINTS[settingKey]}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {options.map((option, index) => {
          const selected = (article[settingKey] ?? undefined) === option.value
          const reason = custom ? unavailableReason(article, settingKey, option.value) : null
          return (
            // The reason sits beside the label, not in it: it describes the choice without renaming it.
            <span key={option.label} className="flex flex-wrap items-baseline gap-x-1.5">
              <label className="flex items-baseline gap-1.5 text-[12px] text-ink">
                <input type="radio" name={id} checked={selected} disabled={reason !== null}
                  data-setting={selected ? `article.${settingKey}` : undefined}
                  aria-invalid={selected && error ? true : undefined}
                  aria-describedby={describedBy(`${id}-hint`, reason && `${id}-reason-${index}`, selected && error && `${id}-error`)}
                  onChange={() => onChange(option.value)} />
                {option.label}
              </label>
              {reason && <span id={`${id}-reason-${index}`} className="text-[10.5px] text-ink-faint">({reason})</span>}
            </span>
          )
        })}
      </div>
      <FieldError id={`${id}-error`} message={error} />
    </fieldset>
  )
}

function NumberField({ path, label, hint, unit, value, edit, disabled, inactive = false, error, onText, placeholder }: {
  path: NumberPath; label: string; hint: string; unit: string; value: number | undefined; edit: string | undefined
  disabled: boolean; inactive?: boolean; error: string | null; onText: (path: NumberPath, text: string) => void
  /** Shown while no value is set: the setting then follows the service defaults. */
  placeholder?: string
}) {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-[11px] font-semibold text-ink-muted">{label}</label>
      <p id={`${id}-hint`} className="text-[10.5px] text-ink-faint">{hint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input id={id} type="text" inputMode="numeric" data-setting={path} value={edit ?? (value === undefined ? '' : String(value))}
          placeholder={placeholder} readOnly={inactive}
          disabled={disabled} aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(`${id}-hint`, `${id}-unit`, error && `${id}-error`)}
          onChange={(event) => onText(path, event.target.value)}
          className="w-32 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[12px] text-ink read-only:bg-surface-muted" />
        <span id={`${id}-unit`} className="text-[11px] text-ink-muted">{inactive ? 'Used with bounded source units' : unit}</span>
      </div>
      <FieldError id={`${id}-error`} message={error} />
    </div>
  )
}

function IdentityFields({ fields, custom, error, add, remove }: {
  fields: readonly string[]; custom: boolean; error: string | null; add: (text: string) => string | null; remove: (name: string) => void
}) {
  const id = useId()
  const [text, setText] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const [selectedField, setSelectedField] = useState('')
  const selected = fields.includes(selectedField) ? selectedField : fields[0]
  const submit = () => {
    const refused = add(text)
    setRefusal(refused)
    if (refused === null) setText('')
  }
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className="text-[11px] font-semibold text-ink-muted">{CONTROL_LABELS.identity_fields}</legend>
      <p id={`${id}-hint`} className="text-[10.5px] text-ink-faint">{CONTROL_HINTS.identity_fields}</p>
      {selected && <div className="flex min-w-0 items-center gap-2">
        <select aria-label="Declared identity fields" value={selected} onChange={(event) => setSelectedField(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[12px] text-ink">
          {fields.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <button type="button" aria-label={`Remove ${selected}`} disabled={!custom} className={`${textButton} text-danger`} onClick={() => remove(selected)}>Remove</button>
      </div>}
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="Identity field name" data-setting="article.identity_fields" value={text} disabled={!custom}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(`${id}-hint`, error && `${id}-error`, refusal && `${id}-refusal`)}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } }}
          className="w-48 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[12px] text-ink" />
        <button type="button" disabled={!custom} onClick={submit} className={`${textButton} text-accent hover:underline`}>Add field</button>
      </div>
      <p id={`${id}-refusal`} aria-live="polite" className="text-[11px] text-danger">{refusal}</p>
      <FieldError id={`${id}-error`} message={error} />
    </fieldset>
  )
}

const FACTORS: readonly CatalogFactor[] = ['glossary', 'headings', 'overlap', 'verification']

/** The Catalog values shown for a saved or drafted override: each unset value is the service default. */
function shownCatalog(catalog: CatalogSettings | undefined) {
  const generic = { discovery_chars: CATALOG_DEFAULTS.discovery_chars, record_chars: CATALOG_DEFAULTS.record_chars, ...catalog?.generic }
  const recipe = { input_tokens: CATALOG_DEFAULTS.input_tokens, output_tokens: CATALOG_DEFAULTS.output_tokens, ...catalog?.recipe }
  const factors = { glossary: true, headings: true, overlap: true, verification: true, ...recipe.factors }
  return { generic, recipe: { ...recipe, factors } }
}

function CatalogSettingsView({ draft, saved, editor, focusIssue }: Pick<Props, 'draft' | 'saved' | 'editor' | 'focusIssue'>) {
  const catalog = draft.extractionSettings.catalog
  const custom = catalog !== undefined
  const { generic, recipe } = shownCatalog(catalog)
  const before = shownCatalog(saved.extractionSettings.catalog)
  const factors = recipe.factors
  const issueAt = (path: NumberPath) => editor.settingsIssues.find((issue) => issue.path === path)?.message ?? null
  const number = (path: NumberPath, key: keyof typeof CATALOG_LABELS, value: number, unit: string, hint: string) => (
    <NumberField path={path} label={CATALOG_LABELS[key]} hint={hint} unit={unit} value={value} edit={editor.numberEdits[path]}
      disabled={!custom} error={issueAt(path)} onText={editor.setNumber} />
  )
  const issue = focusIssue ? editor.settingsIssues.find((item) => item.path.startsWith('catalog.')) : undefined
  const pages = [
    { title: `Generic Catalog: ${CATALOG_LABELS.discovery_chars}`, path: 'catalog.generic.discovery_chars', section: 'Generic Catalog', changed: JSON.stringify(generic) !== JSON.stringify(before.generic),
      control: number('catalog.generic.discovery_chars', 'discovery_chars', generic.discovery_chars, 'characters, at least 1,000', 'Source text per discovery call. A supported control, not a studied factor.') },
    { title: `Generic Catalog: ${CATALOG_LABELS.record_chars}`, path: 'catalog.generic.record_chars', section: 'Generic Catalog', changed: JSON.stringify(generic) !== JSON.stringify(before.generic),
      control: number('catalog.generic.record_chars', 'record_chars', generic.record_chars, 'characters, at least 1,000', 'Source text per record call. Not the Article whole-passage guarantee.') },
    { title: `Recipe Catalog: ${CATALOG_LABELS.input_tokens}`, path: 'catalog.recipe.input_tokens', section: 'Recipe Catalog', changed: JSON.stringify(recipe) !== JSON.stringify(before.recipe),
      control: number('catalog.recipe.input_tokens', 'input_tokens', recipe.input_tokens, 'tokens, at least 64', 'Per-entry input budget; it must fit the served model with the output reserve.') },
    { title: `Recipe Catalog: ${CATALOG_LABELS.output_tokens}`, path: 'catalog.recipe.output_tokens', section: 'Recipe Catalog', changed: JSON.stringify(recipe) !== JSON.stringify(before.recipe),
      control: number('catalog.recipe.output_tokens', 'output_tokens', recipe.output_tokens, 'tokens, at least 64', 'Reserved for each reply. Budgets that do not fit are refused before model calls.') },
    ...FACTORS.map((factor) => ({ title: `Recipe Catalog: ${CATALOG_LABELS[factor]}`, path: `catalog.recipe.factors.${factor}`, section: 'Recipe Catalog', changed: factors[factor] !== before.recipe.factors[factor],
      control: <label className="flex items-center gap-2 text-[12px] text-ink">
        <input type="checkbox" role="switch" aria-checked={factors[factor]} checked={factors[factor]}
          data-setting={`catalog.recipe.factors.${factor}`} onChange={(event) => editor.setCatalogFactor(factor, event.target.checked)} />
        {CATALOG_LABELS[factor]}
      </label> })),
  ]
  return (
    <SettingsViews label="Catalog setting" titles={pages.map((page) => page.title)} selected={pages.find((page) => page.path === issue?.path)?.title}>
      {pages.map((page) => <section key={page.path} aria-label={page.section} className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="text-[12px] font-semibold text-ink">{page.section}</h4>
          {page.changed && <span className="text-[10.5px] font-semibold text-accent">Changed</span>}
          {explain(SECTION_TOPIC[page.section === 'Generic Catalog' ? 'generic' : 'recipe'], page.section)}
        </div>
        <p className="text-[11px] text-ink-faint">{page.section === 'Generic Catalog' ? 'Applies when a Catalog Extraction uses Model discovery.' : 'Applies when a Catalog Extraction uses a numbered-catalogue recipe.'}</p>
        <fieldset disabled={!custom}>{page.control}</fieldset>
        {page.path.endsWith('verification') && !factors.verification && <p className="text-[11px] text-ink-muted">Off keeps typed values as proposals, not accepted evidence.</p>}
        {page.path.includes('.factors.') && <p className="text-[10.5px] text-ink-faint">Switches never turn off structural ownership or canonical spans. Glossary off also turns off glossary normalization.</p>}
      </section>)}
    </SettingsViews>
  )
}

/** What the draft still holds of the retired generic and recipe Catalog controls, in the researcher's words. */
function retiredCatalog(catalog: CatalogSettings | undefined): string[] {
  const lines: string[] = []
  const generic = catalog?.generic
  const recipe = catalog?.recipe
  if (generic?.discovery_chars !== undefined) lines.push(`${CATALOG_LABELS.discovery_chars}: ${generic.discovery_chars.toLocaleString('en-US')} characters`)
  if (generic?.record_chars !== undefined) lines.push(`${CATALOG_LABELS.record_chars}: ${generic.record_chars.toLocaleString('en-US')} characters`)
  if (recipe?.input_tokens !== undefined) lines.push(`Recipe ${CATALOG_LABELS.input_tokens.toLowerCase()}: ${recipe.input_tokens.toLocaleString('en-US')} tokens`)
  if (recipe?.output_tokens !== undefined) lines.push(`Recipe ${CATALOG_LABELS.output_tokens.toLowerCase()}: ${recipe.output_tokens.toLocaleString('en-US')} tokens`)
  const off = recipe?.factors ? FACTORS.filter((factor) => !recipe.factors![factor]).map((factor) => CATALOG_LABELS[factor].toLowerCase()) : []
  if (off.length > 0) lines.push(`Recipe factors off: ${off.join(', ')}`)
  return lines
}

/** The unified Catalog's five controls: one group for every new single and batch Catalog Extraction. Retired generic
 *  and recipe values are shown, never converted; replacing them is the researcher's explicit Apply. */
function UnifiedCatalogView({ draft, saved, editor, focusIssue }: Pick<Props, 'draft' | 'saved' | 'editor' | 'focusIssue'>) {
  const catalog = draft.extractionSettings.catalog
  const unified = catalog?.unified
  const custom = unified !== undefined
  const shown = unified ?? {}
  const defaults = UNIFIED_CATALOG_DEFAULTS[UNIFIED_CATALOG_DEFAULTS_VERSION]
  const retired = retiredCatalog(catalog)
  const issueAt = (path: NumberPath) => editor.settingsIssues.find((issue) => issue.path === path)?.message ?? null
  const number = (key: 'input_tokens' | 'output_tokens' | 'overlap', unit: string, hint: string, placeholder: string) => {
    const path = `catalog.unified.${key}` as const
    return <NumberField path={path} label={UNIFIED_LABELS[key]} hint={hint} unit={unit} value={shown[key]} placeholder={placeholder}
      edit={editor.numberEdits[path]} disabled={!custom} error={issueAt(path)} onText={editor.setNumber} />
  }
  const toggle = (key: 'headings' | 'verification') => (
    <label className="flex items-center gap-2 text-[12px] text-ink">
      <input type="checkbox" role="switch" aria-checked={shown[key] ?? defaults[key]} checked={shown[key] ?? defaults[key]}
        data-setting={`catalog.unified.${key}`} onChange={(event) => editor.setUnified(key, event.target.checked)} />
      {UNIFIED_LABELS[key]}
    </label>
  )
  const reserves = Object.entries(defaults.reserves).map(([stage, tokens]) => `${stage} ${tokens.toLocaleString('en-US')}`).join(', ')
  const method = { defaults: UNIFIED_CATALOG_DEFAULTS_VERSION, ...shown }
  return (
    <>
      <p className="text-[12px] text-ink">{custom ? settingsHeadline({ unified: method }) : `Service defaults, version ${UNIFIED_CATALOG_DEFAULTS_VERSION}`}</p>
      {retired.length > 0 && (
        <div role="note" className="rounded-md border border-line bg-surface-muted px-2.5 py-2 text-[11.5px] text-ink">
          <p className="font-semibold">Your Catalog settings still hold retired controls</p>
          <ul className="list-disc pl-4">{retired.map((line) => <li key={line}>{line}</li>)}</ul>
          <p className="mt-1">They are not converted: character limits are not token budgets, and recipe choices no longer select
            a method. Choose Use service defaults or Customize, then Apply, to replace them. Until then new Catalog Extractions
            are refused; Article Extractions and existing results are unaffected.</p>
        </div>
      )}
      <SettingsViews label="Catalog setting" titles={['Catalog', 'Effective settings']}
        selected={focusIssue && editor.settingsIssues.some((issue) => issue.path.startsWith('catalog.')) ? 'Catalog' : undefined}>
        <section aria-label="Catalog" className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <h4 className="text-[12px] font-semibold text-ink">Catalog</h4>
            {JSON.stringify(unified ?? null) !== JSON.stringify(saved.extractionSettings.catalog?.unified ?? null) &&
              <span className="text-[10.5px] font-semibold text-accent">Changed</span>}
            {explain(SECTION_TOPIC.unified, 'Catalog')}
          </div>
          <p className="text-[11px] text-ink-faint">One method for every new single and batch Catalog Extraction.</p>
          <fieldset disabled={!custom} className="flex min-w-0 flex-col gap-3">
            {number('input_tokens', 'tokens, 512 or more; empty for Auto', 'The largest request of any call. Auto is the served context minus the reply reserve. A smaller ceiling splits the source into more requests; no source text is left out to fit.', 'Auto')}
            {number('output_tokens', 'tokens, 64 or more; empty for the stage defaults', `Reserved for each reply and counted before the call; a cut-off reply never counts as complete. Stage defaults: ${reserves}.`, 'Stage defaults')}
            {number('overlap', 'source lines, 0 to 4', 'Neighboring lines shown again as context where the source is split. Each line is read as its own text once; a record continues across a split only when both sides say so.', String(defaults.overlap))}
            {toggle('headings')}
            {toggle('verification')}
            {!(shown.verification ?? defaults.verification) && <p className="text-[11px] text-ink-muted">Off keeps typed values as proposals, not accepted evidence. Source ownership and exact spans are still checked.</p>}
            <p className="text-[10.5px] text-ink-faint">Records and fields come from the schema; models from the Models tab. Document-level fields remain unverified.</p>
          </fieldset>
        </section>
        <section aria-label="Effective settings" className="flex flex-col gap-2">
          <h4 className="text-[12px] font-semibold text-ink">Effective settings</h4>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
            {unifiedLines(method).map((line) => [<dt key={`${line.label}-t`} className="text-ink-muted">{line.label}</dt>, <dd key={`${line.label}-d`} className="text-ink">{line.value}</dd>])}
          </dl>
          <p className="text-[11.5px] text-ink-muted">Each Extraction records the budgets it resolved from the served models before any call; a later change never alters it.</p>
          <details className="text-[11px] text-ink-muted">
            <summary className="cursor-pointer font-semibold text-ink">Technical details</summary>
            {editor.settingsIssues.some((issue) => issue.path.startsWith('catalog.'))
              ? <p>Fix the issues above to preview the request.</p>
              : <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono">{JSON.stringify(keiMethodOptions(
                  extractionMethod('CATALOG', null, draft.extractionModels, { unified: method })), null, 2)}</pre>}
          </details>
        </section>
      </SettingsViews>
    </>
  )
}
