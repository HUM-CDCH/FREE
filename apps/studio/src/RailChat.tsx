import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { RecordScope } from 'extraction/schema'
import { nodesToTemplate } from 'extraction/schema'
import { countTemplateFields } from '../shared/template'
import ChatDrawer from './ChatDrawer'
import { DeleteDialog } from './ui'
import type { SchemaEditorController } from './currentSchemaRevision'
import { extractStep, nextStep, type GuideInput, type ProjectGuideInput, type StepAction, type StepCard, type StepOption } from './chatGuide'
import { ChatTranscript } from './SchemaChatParts'
import { useSameTemplateAsRun } from './useSameTemplateAsRun'
import { chatMessageClass } from './chatMessageClass'
import { CONVERSATION_EMPTY } from './SchemaPanel'
import { SchemaInstructionsChat } from './SchemaInstructions'
import type { SchemaChat } from './useSchemaChat'

const PRE_SCHEMA_EMPTY = "Ask about the document, or say what to extract. I'll suggest a template when you're ready."

export type RailChatProps = {
  chat: SchemaChat
  schema: SchemaEditorController
  sourceDocumentName: string
  /** Extraction Schema generation; omitted where generation is unavailable. */
  onGenerate?: (instruction: string) => void
  recordScope?: { value: RecordScope | null; onChange: (scope: RecordScope) => void; disabled?: boolean }
  /** Run extraction, where the workspace offers it. */
  run?: { start: () => void; available: boolean; unavailableReason: string | null } | null
  /** The project's workflow, where the workspace knows its project: the guide's view of it, and what its steps do. */
  project?: {
    guide: ProjectGuideInput
    start: (kind: 'pilot' | 'batch', sourceDocumentIds: readonly string[]) => void
    approve: () => void
    /** Stops the project's running Batch Extraction: every member still at work. */
    stopBatch: () => void
    open: (target: NonNullable<StepOption['target']>) => void
    /** Exports the ticked documents' results, once their options and format are chosen. */
    export: (sourceDocumentIds: readonly string[]) => void
  } | null
  /** Pause, Resume, Retry and Stop for the latest Extraction, where the workspace offers them. */
  control?: (Exclude<GuideInput['control'], null> & { command: (action: 'pause' | 'resume' | 'retry' | 'stop') => void }) | null
  latest: GuideInput['latest']
  /** A read-only inspection: the chat offers no step. */
  readOnly?: boolean
  /** Results is the rail's open view. */
  resultsShown?: boolean
  /** The Template view is the rail's open view. */
  templateShown?: boolean
  onShowView: (view: 'chat' | 'schema' | 'results') => void
  /** `full`: the rail's home, the whole conversation filling it. `step`: under another view, the next step and the
   *  composer; sending, or the conversation's dot, returns to the home to show the reply. */
  mode?: 'full' | 'step'
}

/**
 * The workspace's chat, the rail's home: the schema chat's conversation (instructions and answers before the first
 * schema, edit requests and proposals after) and the next step with its numbered options. Under another rail view the
 * next step and the composer stay in view, so the way on is always the chat's.
 */
export default function RailChat({ chat, schema, sourceDocumentName, onGenerate, recordScope, run = null, control = null, project = null, latest, readOnly = false, resultsShown = false, templateShown = false, onShowView, mode = 'full' }: RailChatProps) {
  const snap = useSyncExternalStore(schema.subscribe, schema.snapshot)
  const { instructions, proposalReview, recovery } = chat
  const pending = proposalReview.pending
  const preSchema = (snap.view === 'empty' || snap.view === 'failed') && !!onGenerate
  const ready = snap.view === 'editing'
  const editable = ready && snap.historicalPreview === null
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  // Every generation adopted (the first, or one generated again over a template) holds the chat at Template ready until
  // the researcher goes on; generating again or leaving the template's editor ends it.
  const [seenReplacement, setSeenReplacement] = useState(snap.replacementVersion)
  const [templateReady, setTemplateReady] = useState(false)
  if (snap.replacementVersion !== seenReplacement) {
    setSeenReplacement(snap.replacementVersion)
    setTemplateReady(true)
  } else if (templateReady && (snap.generating || snap.view !== 'editing')) setTemplateReady(false)
  // Likewise each run of this document seen at work and then completed holds the chat at Results ready; a run already
  // completed when the chat first sees it (an opened document) does not.
  const [seenRun, setSeenRun] = useState(latest && { id: latest.extractionId, status: latest.status })
  const [resultsReady, setResultsReady] = useState<string | null>(null)
  if ((latest?.extractionId ?? null) !== (seenRun?.id ?? null) || (latest && latest.status !== seenRun?.status)) {
    setSeenRun(latest && { id: latest.extractionId, status: latest.status })
    setResultsReady(latest?.status === 'COMPLETED' && seenRun?.id === latest.extractionId ? latest.extractionId
      : latest?.extractionId === resultsReady ? resultsReady : null)
  }
  // The last run's template against the current one, compared by content, not only by revision.
  const sameTemplate = useSameTemplateAsRun(schema, latest?.schemaRevisionId ?? null)

  const guide: GuideInput = {
    view: snap.view,
    generating: snap.generating,
    generationError: snap.generationError,
    readOnly: readOnly || snap.historicalPreview !== null,
    canGenerate: !!onGenerate,
    asking: chat.asking !== null,
    instructionCount: instructions.count,
    sourceDocumentName,
    proposal: pending && {
      added: pending.changes.filter((change) => change.kind === 'added').length,
      removed: pending.changes.filter((change) => change.kind === 'removed').length,
      modified: pending.changes.filter((change) => change.kind === 'modified').length,
      unresolved: pending.changes.flatMap((change) => change.outcome === 'unresolved' && change.reason ? [change.reason] : []),
      canApply: proposalReview.canApply,
    },
    recordScope: recordScope ? recordScope.value : undefined,
    revision: {
      id: snap.extractableSchemaRevisionId,
      number: snap.currentRevisionNumber ?? null,
      fieldCount: ready ? countTemplateFields(nodesToTemplate(snap.draft!.schemaNodes)) : 0,
    },
    run: run && { unavailableReason: run.unavailableReason, available: run.available },
    control: control && { busy: control.busy, continueBlocked: control.continueBlocked,
      continueDescription: control.continueDescription, pauseDescription: control.pauseDescription },
    latest: latest && { ...latest, sameTemplate },
    resultsShown,
    templateShown,
    templateReady,
    resultsReady: resultsReady !== null && resultsReady === latest?.extractionId,
    dismissed,
    project: project?.guide ?? null,
  }
  // A message that asked to extract is answered by its own step until the researcher chooses; else the next step.
  const step = chat.extractRequest !== null && !readOnly ? extractStep(guide, chat.extractRequest) : nextStep(guide)
  // The documents ticked in the step's picker: its own initial ones until the researcher changes them.
  const [ticked, setTicked] = useState<{ key: string; ids: ReadonlySet<string> } | null>(null)
  const picked = step?.picker ? (ticked?.key === step.key ? ticked.ids : new Set(step.picker.initial)) : null

  function choose(card: StepCard, option: StepOption, text = '') {
    const ids = option.picks && card.picker && picked ? card.picker.documents.map(({ id }) => id).filter((id) => picked.has(id)) : []
    if (option.disabled || (option.picks && !pickable(card, ids.length))) return
    // Past the step, something else said instead: the message itself joins the conversation, which answers it.
    const said = option.action === 'dismiss' ? text.trim() : ''
    if (said) {
      if (!canSay) return
      reveal()
      void (preSchema ? chat.ask(said) : chat.send(said))
    } else if (option.action !== 'review-schema' && !(card.key.startsWith('results-ready:') && option.action === 'review'))
      chat.appendStep(card.title, option.action === 'dismiss' ? 'Not yet' : option.picks ? pickedLabel(option, ids.length) : option.label)
    // Template ready waits for a way on: viewing the template keeps it, any other choice ends it.
    if (card.key.startsWith('template-ready:') && option.action !== 'review-schema') setTemplateReady(false)
    // Results ready likewise: opening Results keeps it, any other choice ends it.
    if (card.key.startsWith('results-ready:') && option.action !== 'review') setResultsReady(null)
    // The extract step answers one request: any choice ends it.
    if (card.key.startsWith('extract:')) {
      chat.clearExtractRequest()
      if (option.action === 'dismiss') return
    }
    const act: Record<StepAction, () => void> = {
      generate: () => onGenerate?.(instructions.text),
      'stop-generation': () => schema.cancelGeneration(),
      apply: chat.apply,
      'review-schema': () => onShowView('schema'),
      continue: () => {},
      discard: chat.discard,
      'scope:records': () => recordScope?.onChange('records'),
      'scope:document': () => recordScope?.onChange('document'),
      run: () => run?.start(),
      review: () => onShowView('results'),
      pause: () => control?.command('pause'),
      resume: () => control?.command('resume'),
      retry: () => control?.command('retry'),
      stop: () => control?.command('stop'),
      'stop-batch': () => project?.stopBatch(),
      pilot: () => project?.start('pilot', ids),
      batch: () => project?.start('batch', ids),
      approve: () => project?.approve(),
      'open-document': () => option.target && project?.open(option.target),
      export: () => project?.export(ids),
      dismiss: () => setDismissed((current) => new Set(current).add(card.key)),
    }
    act[option.action]()
  }

  // The home always shows the conversation; elsewhere the step stands in for it.
  const open = mode === 'full'
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = bodyRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [chat.messages.length, instructions.items.length, chat.asking, pending, open])
  const dot = open ? null : recovery.running.length > 0 ? { title: 'An earlier request is still running' }
    : chat.messages.length > 0 || instructions.items.length > 0 || pending ? { title: 'Show conversation' } : null
  // A message sent from another view is answered in the conversation: the home shows it.
  const reveal = () => { if (mode === 'step') onShowView('chat') }
  // A step with a way past it carries the composer as its last numbered option: sending from it says something else
  // instead, so it sets the step aside as choosing that option does.
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const sayOption = step?.options.find((option) => option.action === 'dismiss')
  const sayInCard = !!step && !!sayOption
  const setAside = () => {
    if (!sayInCard || !step) return
    if (step.key.startsWith('template-ready:')) setTemplateReady(false)
    if (step.key.startsWith('results-ready:')) setResultsReady(null)
    if (step.key.startsWith('extract:')) chat.clearExtractRequest()
    else setDismissed((current) => new Set(current).add(step.key))
  }
  const ask = () => { if (!instructions.draft.trim()) return; reveal(); setAside(); void chat.ask() }
  const send = () => { if (!chat.input.trim()) return; reveal(); setAside(); void chat.send(chat.input) }

  const blocked = !!pending || chat.loading
  // What is typed in place of a step goes where the composer's message would.
  const canSay = preSchema ? chat.asking === null : editable && !blocked
  const card = (composer: ReactNode) => step && <StepCardView key={step.key} card={step} scopeDisabled={!!recordScope?.disabled} sayDisabled={!canSay}
    onChoose={(option) => choose(step, option)} picked={picked} onPick={(ids) => setTicked({ key: step.key, ids })}
    composer={composer} onSay={() => composerRef.current?.focus()} />
  // The Generate template step set aside: folded to its title line, generating stays one click away and the title
  // brings the whole step back.
  const generate = !step && preSchema && (
    <SetAsideStepView title="Generate template" summary={instructions.count > 0 ? plural(instructions.count, 'instruction') : 'no instructions'}
      expandLabel="Show the Generate template step"
      onExpand={() => setDismissed((current) => new Set([...current].filter((key) => !key.startsWith('generate:'))))}
      action={{ label: 'Generate', name: `Generate template${instructions.countLabel}`, disabled: chat.asking !== null,
        run: () => onGenerate?.(instructions.text) }} />
  )
  // The whole conversation cleared, once confirmed: not while a reply or a proposal is on its way.
  const [confirmingClear, setConfirmingClear] = useState(false)
  const clearRef = useRef<HTMLButtonElement>(null)
  const clearBusy = chat.asking !== null || chat.loading || !!pending
  const clear = !readOnly && (chat.messages.length > 0 || instructions.items.length > 0) && (
    <button ref={clearRef} type="button" disabled={clearBusy} onClick={() => setConfirmingClear(true)}
      title={clearBusy ? 'Clear the conversation once the reply or proposal is settled' : 'Clear the conversation'}
      className="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-compact text-ink-muted outline-none transition-colors hover:bg-surface hover:text-danger disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted">
      Clear conversation
    </button>
  )
  const composerClass = 'min-w-0 flex-1 resize-none bg-transparent font-sans text-secondary leading-relaxed text-ink outline-none placeholder:text-ink-faint disabled:opacity-50'
  const sendClass = 'grid size-7 shrink-0 cursor-pointer place-items-center rounded-md bg-green text-compact text-white outline-none hover:brightness-108 disabled:opacity-40'
  // In a card the composer is its way past the step, and says so; else what the conversation takes now.
  const composerHint = sayInCard && (preSchema || editable) ? sayOption!.label
    : preSchema ? 'Add a generation instruction (e.g. "Focus on names, dates, and locations"), or ask about the document…'
      : editable ? 'Describe a change to the template…' : 'The chat continues once the template is ready.'
  const composer = preSchema ? (
    <>
      <textarea ref={composerRef} className={composerClass} rows={sayInCard ? 2 : 3} aria-label={composerHint} placeholder={composerHint} value={instructions.draft}
        onChange={(event) => instructions.setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); ask() } }} />
      {chat.asking !== null ? (
        <button type="button" className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md bg-danger text-compact text-white outline-none hover:brightness-108"
          onClick={chat.stopAsking} title="Stop and edit the message" aria-label="Stop the reply">■</button>
      ) : (
        <button type="button" aria-label="Send message" className={sendClass}
          disabled={!instructions.draft.trim()} onClick={ask}>↑</button>
      )}
    </>
  ) : (
    <>
      <textarea ref={composerRef} className={composerClass} rows={sayInCard ? 2 : 3} aria-label={composerHint} placeholder={composerHint} value={chat.input} disabled={!editable || blocked}
        onChange={(event) => chat.setInput(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() } }} />
      {chat.loading ? (
        <button type="button" className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md bg-danger text-compact text-white outline-none hover:brightness-108"
          onClick={chat.cancel} title="Stop and edit the message" aria-label="Stop template edit request">■</button>
      ) : (
        <button type="button" className={sendClass}
          aria-label="Send" disabled={!editable || !chat.input.trim() || blocked} onClick={send}>↑</button>
      )}
    </>
  )

  const instructionsConversation = instructions.items.length > 0 || chat.asking !== null || chat.askError ? (
    <>
      <SchemaInstructionsChat instructions={instructions} messageClass={chatMessageClass} asking={chat.asking} />
      {chat.askError && <p className="text-compact text-danger [overflow-wrap:anywhere]" role="alert">{chat.askError}</p>}
    </>
  ) : undefined

  // While a step offers a way past it, the composer is drawn in the card and the drawer has none of its own.
  const shownCard = step && (sayInCard ? card(composer) : card(null))
  return (
    <>
      <ChatDrawer open={open} fill={open} onCollapse={() => onShowView('chat')} onExpand={() => onShowView('chat')}
        title="Conversation" label={shownCard || generate} dot={dot} actions={clear || undefined} bodyRef={bodyRef}
        bar={shownCard || generate || undefined} composer={sayInCard ? null : composer}>
        <ChatTranscript chat={chat} empty={preSchema ? PRE_SCHEMA_EMPTY : CONVERSATION_EMPTY} before={instructionsConversation} />
      </ChatDrawer>
      {confirmingClear && (
        <DeleteDialog title="Clear the conversation?" confirmLabel="Clear conversation" returnFocusRef={clearRef}
          description="Every message, instruction, answered step and document turn of this project's chat is removed for good. The template is not changed, but it is generated again without the instructions kept so far."
          onCancel={() => setConfirmingClear(false)}
          onConfirm={async () => {
            try {
              await chat.clearConversation()
              // Steps set aside before are asked afresh.
              setDismissed(new Set())
              return null
            } catch (error) {
              return { message: error instanceof Error ? error.message : 'The conversation could not be cleared.' }
            }
          }} />
      )}
    </>
  )
}

const optionClass: Record<StepOption['tone'], string> = {
  positive: 'border-green bg-green text-white hover:brightness-108',
  secondary: 'border-line bg-surface text-ink hover:border-line-strong hover:bg-surface-muted',
  danger: 'border-danger/40 bg-surface text-danger hover:border-danger hover:bg-danger-soft',
  dismiss: 'border-transparent bg-transparent text-ink-muted hover:bg-surface-muted hover:text-ink',
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
/** A picking option's label with the documents it acts on. */
const pickedLabel = (option: StepOption, count: number) => option.label.replace('{n}', plural(count, 'document'))
const pickable = (card: StepCard, count: number) => count > 0 && count <= (card.picker?.limit ?? 0)

/** A step set aside, folded to the card's title line: the same left edge and ⏵, a summary, and its one action. The
 *  title brings the whole step back. */
function SetAsideStepView({ title, summary, expandLabel, onExpand, action }: {
  title: string; summary: string; expandLabel: string; onExpand: () => void
  action: { label: string; name: string; disabled: boolean; run: () => void }
}) {
  return (
    <section aria-label={`${title}, set aside`} className="mx-4 my-2 flex shrink-0 items-center gap-2 rounded-[3px] border border-line-strong border-l-[3px] border-l-accent bg-surface px-2.5 py-1">
      <button type="button" aria-label={expandLabel} title={expandLabel} onClick={onExpand}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-none">
        <span aria-hidden="true" className="text-accent">⏵</span>
        <span className="truncate text-secondary font-bold text-ink">{title}</span>
        <span className="shrink-0 text-compact text-ink-faint">· {summary}</span>
      </button>
      <button type="button" aria-label={action.name} title={action.name} disabled={action.disabled} onClick={action.run}
        className="shrink-0 cursor-pointer rounded-[3px] border border-green bg-green px-2 py-0.5 text-compact font-semibold text-white outline-none transition-colors hover:brightness-108 disabled:cursor-default disabled:opacity-50">
        {action.label}
      </button>
    </section>
  )
}

/** The next step: a permission card with numbered options. 1–9 choose while it has focus. A step that acts on
 *  documents lists the project's to tick. The way past it (`dismiss`) is the chat's composer, drawn as the card's last
 *  numbered option: its number focuses it (`onSay`), and sending from it says something else instead and sets the step
 *  aside; Esc, or the header's ×, sets it aside unsaid. */
function StepCardView({ card, scopeDisabled = false, sayDisabled = false, onChoose, picked = null, onPick, composer, onSay }: {
  card: StepCard; scopeDisabled?: boolean; sayDisabled?: boolean; onChoose: (option: StepOption) => void
  picked?: ReadonlySet<string> | null; onPick?: (ids: ReadonlySet<string>) => void
  composer: ReactNode; onSay: () => void
}) {
  const count = picked?.size ?? 0
  const options = card.options.map((option) =>
    scopeDisabled && option.action.startsWith('scope:') ? { ...option, disabled: true }
      : option.picks ? { ...option, label: pickedLabel(option, count), disabled: option.disabled || !pickable(card, count) } : option)
  const dismiss = options.find(({ action }) => action === 'dismiss')
  return (
    <section aria-label={card.title} className={`mx-4 shrink-0 rounded-[3px] border border-line-strong border-l-[3px] border-l-accent bg-surface ${dismiss ? 'mt-2 mb-3' : 'my-2'}`}
      onKeyDown={(event) => {
        // Typing goes to the field; only Esc still closes the step from there.
        if ((event.target as HTMLElement).matches('textarea, input') && event.key !== 'Escape') return
        const index = Number(event.key) - 1
        const escape = event.key === 'Escape'
        const option = Number.isInteger(index) && index >= 0 ? options[index] : escape ? dismiss : undefined
        if (!option) return
        event.preventDefault()
        if (option.action === 'dismiss' && !escape) onSay()
        else onChoose(option)
      }}>
      <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5">
        {card.busy
          ? <span aria-hidden="true" className="size-3 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-ink" />
          : <span aria-hidden="true" className="text-accent">⏵</span>}
        <span className="min-w-0 flex-1 truncate text-secondary font-bold text-ink" title={card.title}>{card.title}</span>
        {dismiss && (
          <button type="button" aria-label="Not yet" title="Not yet (Esc)" onClick={() => onChoose(dismiss)}
            className="shrink-0 cursor-pointer rounded-md px-1 leading-none text-ink-faint outline-none transition-colors hover:bg-surface-muted hover:text-ink">
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
      <div className="flex flex-col gap-2 px-2.5 py-2">
        {card.detail && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-compact">
            {card.detail.map(([term, value]) => (
              <div key={term} className="contents">
                <dt className="text-ink-faint">{term}</dt>
                <dd className="min-w-0 font-mono [overflow-wrap:anywhere] text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {card.error && <p role="alert" className="text-compact leading-snug text-danger [overflow-wrap:anywhere]">{card.error}</p>}
        {card.notice && <p role="status" className="text-compact leading-snug text-ink-muted [overflow-wrap:anywhere]">{card.notice}</p>}
        {card.question && <p className="text-secondary font-semibold text-ink [overflow-wrap:anywhere]">{card.question}</p>}
        {card.picker && picked && (
          <fieldset className="scrollbar-subtle flex max-h-44 min-w-0 flex-col gap-0.5 overflow-y-auto rounded-[3px] border border-line bg-surface-muted px-2 py-1.5">
            <legend className="sr-only">Documents</legend>
            {card.picker.documents.map((document) => (
              <label key={document.id} className="flex min-w-0 cursor-pointer items-center gap-2 text-compact text-ink">
                <input type="checkbox" className="shrink-0 accent-accent" checked={picked.has(document.id)}
                  onChange={(event) => {
                    const next = new Set(picked)
                    if (event.target.checked) next.add(document.id)
                    else next.delete(document.id)
                    onPick?.(next)
                  }} />
                <span className="min-w-0 truncate" title={document.name}>{document.name}</span>
              </label>
            ))}
          </fieldset>
        )}
        {card.picker && count > card.picker.limit && (
          <p role="status" className="text-compact leading-snug text-danger">At most {plural(card.picker.limit, 'document')} at once.</p>
        )}
        {options.length > 0 && (
          <div className="flex flex-col gap-1">
            {options.map((option, index) => option.action === 'dismiss' ? (
              // The way past the step is the chat's composer itself, numbered as the card's last option.
              <div key={option.action}
                className={`flex items-end gap-2 rounded-[3px] border border-line bg-surface px-2 py-1.5 focus-within:border-ink-faint ${sayDisabled ? 'opacity-60' : ''}`}>
                <span aria-hidden="true" className="w-3 shrink-0 self-start pt-0.5 font-mono text-compact font-semibold text-ink opacity-70">{index + 1}</span>
                {composer}
              </div>
            ) : (
              <button key={option.action} type="button" disabled={option.disabled}
                title={option.description} aria-description={option.description}
                className={`flex min-h-7 cursor-pointer items-baseline gap-2 rounded-[3px] border px-2 py-1 text-left text-compact font-semibold outline-none transition-colors disabled:cursor-default disabled:opacity-50 ${optionClass[option.tone]}`}
                onClick={() => onChoose(option)}>
                <span aria-hidden="true" className="w-3 shrink-0 font-mono opacity-70">{index + 1}</span>
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {option.label}
                  {option.hint && <span className="block font-normal opacity-80">{option.hint}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
