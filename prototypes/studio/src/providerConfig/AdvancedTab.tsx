import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import {
  CATALOG_DEFAULTS, extractionMethod, keiMethodOptions, REFERENCE_ARTICLE, type ArticleSettings, type CatalogSettings,
} from 'extraction/extraction-method'
import type { ModelConfig } from '../../shared/modelConfig.contract'
import { ExplainButton, GuideProvider, HowThisWorksButton } from './AdvancedGuide'
import { SECTION_TOPIC, type GuideTopicId } from './advancedGuide.data'
import {
  ARTICLE_CHOICES, ARTICLE_SECTIONS, CATALOG_LABELS, CONTROL_HINTS, CONTROL_LABELS, changedSections, effectiveSummary,
  issueSection, matchingStartingPoint, sectionSummary, unavailableReason, type AdvancedStrategy, type ArticleKey,
  type ArticleSection, type CatalogFactor, type NumberPath,
} from './advancedSettings'
import type { ProviderConfigDraft } from './useProviderConfigDraft'

export type AdvancedEditor = Pick<ProviderConfigDraft,
  'customize' | 'useServiceDefaults' | 'setArticle' | 'replaceArticle' | 'addIdentityField' | 'removeIdentityField' |
  'setCatalogFactor' | 'setNumber' | 'numberEdits' | 'settingsIssues'>

type Props = {
  draft: ModelConfig
  saved: ModelConfig
  editor: AdvancedEditor
  /** Set by the footer's issue summary: show the first issue's section, focus its control, then report it handled. */
  focusIssue: boolean
  onIssueFocused: () => void
}

/** The starting point last used, and the Article draft (with its number text) that Undo restores. */
type Applied = Readonly<{ name: string; prior: ArticleSettings | undefined; priorEdits: ProviderConfigDraft['numberEdits'] }>

const STRATEGIES: readonly { value: AdvancedStrategy; label: string }[] = [
  { value: 'article', label: 'Article' }, { value: 'catalog', label: 'Catalog' },
]
const textButton = 'text-[11.5px] font-semibold transition-colors'
const describedBy = (...ids: readonly (string | false | null)[]) => ids.filter(Boolean).join(' ')
/** A section's Explain action, at the top of the opened section: never inside the summary row that toggles it, and
 *  outside the controls' fieldset, so it works while service defaults are in use. */
const explain = (topic: GuideTopicId, subject: string) => (
  <div className="flex justify-end"><ExplainButton topic={topic} subject={subject} /></div>
)

/** Saved method settings for future Extractions, per strategy, in the page's one draft. Choosing which strategy's
 *  settings to edit never changes any Extraction's strategy. */
export function AdvancedTab({ draft, saved, editor, focusIssue, onIssueFocused }: Props) {
  const [strategy, setStrategy] = useState<AdvancedStrategy>('article')
  const root = useRef<HTMLElement>(null)
  const guideTrigger = useRef<HTMLButtonElement>(null)
  const headingId = useId()
  const [applied, setApplied] = useState<Applied | null>(null)
  // Discard and Apply make the draft the saved document again (the same object): that ends the notice and its Undo.
  if (applied && draft === saved) setApplied(null)
  // It also ends once the Article draft no longer has the starting point's settings; names are derived, never stored.
  const notice = applied && matchingStartingPoint(draft.extractionSettings.article)?.name === applied.name ? applied : null
  const first = editor.settingsIssues[0]
  const issueStrategy: AdvancedStrategy | null = first ? (first.path.startsWith('catalog.') ? 'catalog' : 'article') : null
  // The footer's request shows the first issue's strategy before anything is committed.
  if (focusIssue && issueStrategy && issueStrategy !== strategy) setStrategy(issueStrategy)
  const custom = draft.extractionSettings[strategy] !== undefined

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
      <section ref={root} aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id={headingId} className="text-[13px] font-bold text-ink">Advanced extraction</h3>
          <HowThisWorksButton triggerRef={guideTrigger} />
        </div>
        <p className="-mt-2 text-[11.5px] text-ink-faint">Applies to new Extractions in your Projects.</p>
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
        <div className="-mt-1">
          <p className="text-[11px] text-ink-faint">Settings for future Extractions using this strategy.</p>
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
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={!custom}
            className={`${textButton} rounded-md border border-line px-2.5 py-1 ${custom ? 'text-ink-muted hover:text-accent' : 'bg-surface-muted text-ink'}`}
            onClick={() => editor.useServiceDefaults(strategy)}>Use service defaults</button>
          <button type="button" aria-pressed={custom}
            className={`${textButton} rounded-md border border-line px-2.5 py-1 ${custom ? 'bg-surface-muted text-ink' : 'text-accent hover:underline'}`}
            onClick={() => { if (!custom) editor.customize(strategy) }}>Customize</button>
        </div>
        {strategy === 'article'
          ? <ArticleSettingsView draft={draft} saved={saved} editor={editor} />
          : <CatalogSettingsView draft={draft} saved={saved} editor={editor} />}
      </section>
    </GuideProvider>
  )
}

function ArticleSettingsView({ draft, saved, editor }: Pick<Props, 'draft' | 'saved' | 'editor'>) {
  const explicit = draft.extractionSettings.article
  const custom = explicit !== undefined
  const article = explicit ?? REFERENCE_ARTICLE
  const changed = changedSections(article, saved.extractionSettings.article)
  const invalid = new Set(editor.settingsIssues.map((issue) => issueSection(issue.path)))
  const issueAt = (key: ArticleKey) => editor.settingsIssues.find((issue) => issue.path === `article.${key}`)?.message ?? null
  const choice = (key: keyof typeof ARTICLE_CHOICES) => (
    <ChoiceGroup key={key} settingKey={key} article={article} custom={custom} error={issueAt(key)}
      onChange={(value) => editor.setArticle(key, value)} />
  )
  const controls: Readonly<Record<ArticleSection, ReactNode>> = {
    context: <>
      {choice('context')}
      <NumberField path="article.context_tokens" label={CONTROL_LABELS.context_tokens} hint={CONTROL_HINTS.context_tokens}
        unit="tokens, at least 8,192" value={article.context_tokens} edit={editor.numberEdits['article.context_tokens']}
        disabled={!custom} inactive={article.context === 'full'} error={issueAt('context_tokens')} onText={editor.setNumber} />
      {choice('grouping')}{choice('overlap_passages')}{choice('selection')}
    </>,
    identity: <>
      {choice('identity')}
      <IdentityFields fields={article.identity_fields} custom={custom} error={issueAt('identity_fields')}
        add={editor.addIdentityField} remove={editor.removeIdentityField} />
    </>,
    input: <>{choice('prompt')}{choice('rendering')}</>,
    evidence: <>
      {choice('grounding')}{choice('evidence_policy')}{choice('grounding_schedule')}{choice('grounding_routing')}
    </>,
  }
  return (
    <>
      <p className="text-[12px] text-ink">{effectiveSummary(explicit)}</p>
      <ul className="flex flex-col gap-2">
        {ARTICLE_SECTIONS.map(({ section, title }) => (
          <li key={section}>
            <Disclosure title={title} value={sectionSummary(article, section)} changed={changed.has(section)} forcedOpen={invalid.has(section)}>
              {explain(SECTION_TOPIC[section], title)}
              <fieldset disabled={!custom} className="flex min-w-0 flex-col gap-3">{controls[section]}</fieldset>
              {section === 'evidence' && <p className="text-[11px] text-ink-faint">Article document-level fields currently remain unverified.</p>}
            </Disclosure>
          </li>
        ))}
        <li>
          <Disclosure title="Effective settings" value="" changed={false} forcedOpen={false}>
            {custom
              ? <p className="text-[12px] text-ink">{effectiveSummary(explicit)}</p>
              : <p className="text-[12px] text-ink">Service defaults; resolved for the Extraction. Today’s documented reference: {effectiveSummary(undefined)}, using each served model’s context size.</p>}
            <p className="text-[11.5px] text-ink-muted">Field and reasoning models follow the Models tab: field values {draft.extractionModels.fields ?? 'deployment default'}, reasoning {draft.extractionModels.reasoning ?? 'deployment default'}.</p>
            <details className="text-[11px] text-ink-muted">
              <summary className="cursor-pointer font-semibold text-ink">Technical details</summary>
              {editor.settingsIssues.some((issue) => issue.path.startsWith('article.'))
                ? <p>Fix the issues above to preview the request.</p>
                : <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono">{JSON.stringify(keiMethodOptions(
                    extractionMethod('ARTICLE', null, draft.extractionModels, { article: explicit ?? null })), null, 2)}</pre>}
            </details>
          </Disclosure>
        </li>
      </ul>
    </>
  )
}

/** A native disclosure row: title, the draft's value, and one "Changed" label. An issue inside keeps it open. */
export function Disclosure({ title, value, changed, forcedOpen, children }: {
  title: string; value: string; changed: boolean; forcedOpen: boolean; children: ReactNode
}) {
  const [opened, setOpened] = useState(false)
  return (
    <details open={opened || forcedOpen} className="rounded-xl border border-line bg-surface"
      // Keeps the state in step with an open the browser makes itself (find in page).
      onToggle={(event) => { if (event.currentTarget.open) setOpened(true) }}>
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2"
        onClick={(event) => {
          // The row is opened and closed here, not natively: collapsing a section with an issue inside would hide why
          // Apply is blocked, so it stays open.
          event.preventDefault()
          if (!forcedOpen) setOpened(!opened)
        }}>
        <span className="text-[12.5px] font-semibold text-ink">{title}</span>
        <span className="min-w-0 flex-1 text-[12px] text-ink-muted">{value}</span>
        {changed && <span className="rounded border border-accent/50 px-1 text-[10.5px] font-semibold text-accent">Changed</span>}
      </summary>
      <div className="flex flex-col gap-3 border-t border-line px-3 py-3">{children}</div>
    </details>
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

function NumberField({ path, label, hint, unit, value, edit, disabled, inactive = false, error, onText }: {
  path: NumberPath; label: string; hint: string; unit: string; value: number; edit: string | undefined
  disabled: boolean; inactive?: boolean; error: string | null; onText: (path: NumberPath, text: string) => void
}) {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-[11px] font-semibold text-ink-muted">{label}</label>
      <p id={`${id}-hint`} className="text-[10.5px] text-ink-faint">{hint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input id={id} type="text" inputMode="numeric" data-setting={path} value={edit ?? String(value)} readOnly={inactive}
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
  const submit = () => {
    const refused = add(text)
    setRefusal(refused)
    if (refused === null) setText('')
  }
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className="text-[11px] font-semibold text-ink-muted">{CONTROL_LABELS.identity_fields}</legend>
      <p id={`${id}-hint`} className="text-[10.5px] text-ink-faint">{CONTROL_HINTS.identity_fields} Conservative reconciliation is the choice that requires declared fields.</p>
      <ul aria-label="Identity fields" className="flex flex-wrap gap-1.5">
        {fields.map((name) => (
          <li key={name} className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 font-mono text-[11.5px] text-ink">
            {name}
            <button type="button" aria-label={`Remove ${name}`} disabled={!custom} className="text-ink-faint hover:text-danger" onClick={() => remove(name)}>×</button>
          </li>
        ))}
      </ul>
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

function CatalogSettingsView({ draft, saved, editor }: Pick<Props, 'draft' | 'saved' | 'editor'>) {
  const catalog = draft.extractionSettings.catalog
  const custom = catalog !== undefined
  const { generic, recipe } = shownCatalog(catalog)
  const before = shownCatalog(saved.extractionSettings.catalog)
  const factors = recipe.factors
  const issueAt = (path: NumberPath) => editor.settingsIssues.find((issue) => issue.path === path)?.message ?? null
  const invalid = new Set(editor.settingsIssues.map((issue) => issueSection(issue.path)))
  const number = (path: NumberPath, key: keyof typeof CATALOG_LABELS, value: number, unit: string, hint: string) => (
    <NumberField path={path} label={CATALOG_LABELS[key]} hint={hint} unit={unit} value={value} edit={editor.numberEdits[path]}
      disabled={!custom} error={issueAt(path)} onText={editor.setNumber} />
  )
  const off = FACTORS.filter((factor) => !factors[factor]).map((factor) => CATALOG_LABELS[factor].toLowerCase())
  return (
    <>
      <p className="text-[12px] text-ink">
        {custom
          ? `Generic: ${generic.discovery_chars.toLocaleString('en-US')} / ${generic.record_chars.toLocaleString('en-US')} characters · Recipe: ${recipe.input_tokens.toLocaleString('en-US')} + ${recipe.output_tokens.toLocaleString('en-US')} tokens, ${off.length === 0 ? 'all factors on' : `off: ${off.join(', ')}`}`
          : 'Service defaults'}
      </p>
      <ul className="flex flex-col gap-2">
        <li>
          <Disclosure title="Generic Catalog" value="Applies when a Catalog Extraction uses Model discovery."
            changed={JSON.stringify(generic) !== JSON.stringify(before.generic)} forcedOpen={invalid.has('generic')}>
            {explain(SECTION_TOPIC.generic, 'Generic Catalog')}
            <fieldset disabled={!custom} className="flex min-w-0 flex-col gap-3">
              {number('catalog.generic.discovery_chars', 'discovery_chars', generic.discovery_chars, 'characters, at least 1,000', 'Source text per discovery call. A supported control, not a studied factor.')}
              {number('catalog.generic.record_chars', 'record_chars', generic.record_chars, 'characters, at least 1,000', 'Source text per record call. Not the Article whole-passage guarantee.')}
            </fieldset>
          </Disclosure>
        </li>
        <li>
          <Disclosure title="Recipe Catalog" value="Applies when a Catalog Extraction uses a numbered-catalogue recipe."
            changed={JSON.stringify(recipe) !== JSON.stringify(before.recipe)} forcedOpen={invalid.has('recipe')}>
            {explain(SECTION_TOPIC.recipe, 'Recipe Catalog')}
            <fieldset disabled={!custom} className="flex min-w-0 flex-col gap-3">
              {number('catalog.recipe.input_tokens', 'input_tokens', recipe.input_tokens, 'tokens, at least 64', 'Per-entry input budget; it must fit the served model with the output reserve.')}
              {number('catalog.recipe.output_tokens', 'output_tokens', recipe.output_tokens, 'tokens, at least 64', 'Reserved for each reply. Budgets that do not fit are refused before model calls.')}
              {FACTORS.map((factor) => (
                <label key={factor} className="flex items-center gap-2 text-[12px] text-ink">
                  <input type="checkbox" role="switch" aria-checked={factors[factor]} checked={factors[factor]}
                    data-setting={`catalog.recipe.factors.${factor}`} onChange={(event) => editor.setCatalogFactor(factor, event.target.checked)} />
                  {CATALOG_LABELS[factor]}
                </label>
              ))}
              {!factors.verification && <p className="text-[11px] text-ink-muted">Off keeps typed values as proposals, not accepted evidence.</p>}
              <p className="text-[10.5px] text-ink-faint">Switches never turn off structural ownership or canonical spans. Glossary off also turns off glossary normalization.</p>
            </fieldset>
          </Disclosure>
        </li>
      </ul>
    </>
  )
}
