import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { RecordScope } from 'extraction/schema'
import { nodesToTemplate } from 'extraction/schema'
import { countTemplateFields } from '../shared/template'
import ChatDrawer from './ChatDrawer'
import type { SchemaEditorController } from './currentSchemaRevision'
import { nextStep, type GuideInput, type StepAction, type StepCard, type StepOption } from './chatGuide'
import { ChatLabel, ChatTranscript } from './SchemaChatParts'
import { chatMessageClass } from './chatMessageClass'
import { CONVERSATION_EMPTY } from './SchemaPanel'
import { SchemaInstructionsChat } from './SchemaInstructions'
import type { SchemaChat } from './useSchemaChat'

const PRE_SCHEMA_EMPTY = "Ask about the document, or say what to extract. I'll suggest a schema when you're ready."

export type RailChatProps = {
  chat: SchemaChat
  schema: SchemaEditorController
  sourceDocumentName: string
  /** Extraction Schema generation; omitted where generation is unavailable. */
  onGenerate?: (instruction: string) => void
  recordScope?: { value: RecordScope | null; onChange: (scope: RecordScope) => void; disabled?: boolean }
  /** Run extraction, where the workspace offers it. */
  run?: { start: () => void; available: boolean; unavailableReason: string | null } | null
  latest: GuideInput['latest']
  /** A read-only inspection: the chat offers no step. */
  readOnly?: boolean
  /** Results is the rail's open tab. */
  resultsShown?: boolean
  onShowTab: (tab: 'schema' | 'results') => void
}

/**
 * The workspace's chat, docked under every rail tab: the schema chat's conversation (instructions and answers before
 * the first schema, edit requests and proposals after) and, always in view, the next step with its numbered options.
 */
export default function RailChat({ chat, schema, sourceDocumentName, onGenerate, recordScope, run = null, latest, readOnly = false, resultsShown = false, onShowTab }: RailChatProps) {
  const snap = useSyncExternalStore(schema.subscribe, schema.snapshot)
  const { instructions, proposalReview, recovery } = chat
  const pending = proposalReview.pending
  const preSchema = (snap.view === 'empty' || snap.view === 'failed') && !!onGenerate
  const ready = snap.view === 'editing'
  const editable = ready && snap.historicalPreview === null
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())

  const step = nextStep({
    view: snap.view,
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
    latest,
    resultsShown,
    dismissed,
  })

  function choose(card: StepCard, option: StepOption) {
    if (option.disabled) return
    if (option.action !== 'review-schema') chat.appendStep(card.title, option.label)
    const act: Record<StepAction, () => void> = {
      generate: () => onGenerate?.(instructions.text),
      'stop-generation': () => schema.cancelGeneration(),
      apply: chat.apply,
      'review-schema': () => onShowTab('schema'),
      discard: chat.discard,
      'scope:records': () => recordScope?.onChange('records'),
      'scope:document': () => recordScope?.onChange('document'),
      run: () => run?.start(),
      review: () => onShowTab('results'),
      dismiss: () => setDismissed((current) => new Set(current).add(card.key)),
    }
    act[option.action]()
  }

  // Before the first schema the conversation is the way in, so it shows unless the researcher collapsed it.
  const open = chat.drawerOpen ?? (recovery.running.length > 0 || preSchema)
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = bodyRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [chat.messages.length, instructions.items.length, chat.asking, pending, open])
  const dot = open ? null : recovery.running.length > 0 ? { title: 'An earlier request is still running' }
    : chat.messages.length > 0 || instructions.items.length > 0 || pending ? { title: 'Show conversation' } : null

  const card = step && <StepCardView card={step} scopeDisabled={!!recordScope?.disabled} onChoose={(option) => choose(step, option)} />
  const blocked = !!pending || chat.loading
  const composerClass = 'min-w-0 flex-1 resize-none bg-transparent font-sans text-secondary leading-relaxed text-ink outline-none placeholder:text-ink-faint disabled:opacity-50'
  const sendClass = 'grid size-7 shrink-0 cursor-pointer place-items-center rounded-md bg-green text-compact text-white outline-none hover:brightness-108 disabled:opacity-40'
  const composer = preSchema ? (
    <>
      <textarea className={composerClass} rows={3}
        placeholder={'Add a generation instruction (e.g. "Focus on names, dates, and locations"), or ask about the document…'} value={instructions.draft}
        onChange={(event) => instructions.setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void chat.ask() } }} />
      <button type="button" aria-label="Send message" className={sendClass}
        disabled={!instructions.draft.trim() || chat.asking !== null} onClick={() => void chat.ask()}>↑</button>
    </>
  ) : (
    <>
      <textarea className={composerClass} rows={3}
        placeholder={editable ? 'Describe a change to the schema…' : 'The chat continues once the schema is ready.'} value={chat.input} disabled={!editable || blocked}
        onChange={(event) => chat.setInput(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void chat.send(chat.input) } }} />
      {chat.loading ? (
        <button type="button" className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md bg-danger text-compact text-white outline-none hover:brightness-108"
          onClick={chat.cancel} title="Stop schema edit request" aria-label="Stop schema edit request">■</button>
      ) : (
        <button type="button" className={sendClass}
          aria-label="Send" disabled={!editable || !chat.input.trim() || blocked} onClick={() => void chat.send(chat.input)}>↑</button>
      )}
    </>
  )

  const instructionsConversation = instructions.items.length > 0 || chat.asking !== null || chat.askError ? (
    <>
      <SchemaInstructionsChat instructions={instructions} messageClass={chatMessageClass} asking={chat.asking} />
      {chat.askError && <p className="text-compact text-danger" role="alert">{chat.askError}</p>}
    </>
  ) : undefined

  return (
    <ChatDrawer open={open} onCollapse={() => chat.setDrawerOpen(false)} onExpand={() => chat.setDrawerOpen(true)}
      title="Conversation" label={<>{card}<ChatLabel optional={preSchema} /></>} dot={dot} bodyRef={bodyRef}
      bar={card ?? undefined} composer={composer}>
      <ChatTranscript chat={chat} empty={preSchema ? PRE_SCHEMA_EMPTY : CONVERSATION_EMPTY} before={instructionsConversation} />
    </ChatDrawer>
  )
}

const optionClass: Record<StepOption['tone'], string> = {
  positive: 'border-green bg-green text-white hover:brightness-108',
  secondary: 'border-line bg-surface text-ink hover:border-line-strong hover:bg-surface-muted',
  danger: 'border-danger/40 bg-surface text-danger hover:border-danger hover:bg-danger-soft',
  dismiss: 'border-transparent bg-transparent text-ink-muted hover:bg-surface-muted hover:text-ink',
}

/** The next step: a permission card with numbered options. 1–9 choose while it has focus; Esc is "Not yet". */
export function StepCardView({ card, scopeDisabled = false, onChoose }: { card: StepCard; scopeDisabled?: boolean; onChoose: (option: StepOption) => void }) {
  const options = card.options.map((option) =>
    scopeDisabled && option.action.startsWith('scope:') ? { ...option, disabled: true } : option)
  return (
    <section aria-label={card.title} className="mx-4 my-2 shrink-0 rounded-[3px] border border-line-strong border-l-[3px] border-l-accent bg-surface"
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).matches('textarea, input')) return
        const index = Number(event.key) - 1
        const option = Number.isInteger(index) && index >= 0 ? options[index] : event.key === 'Escape' ? options.find(({ tone }) => tone === 'dismiss') : undefined
        if (!option) return
        event.preventDefault()
        onChoose(option)
      }}>
      <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5">
        {card.busy
          ? <span aria-hidden="true" className="size-3 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-ink" />
          : <span aria-hidden="true" className="text-accent">⏵</span>}
        <span className="min-w-0 truncate text-secondary font-bold text-ink">{card.title}</span>
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
        {card.error && <p role="alert" className="text-compact leading-snug text-danger">{card.error}</p>}
        {card.notice && <p role="status" className="text-compact leading-snug text-ink-muted">{card.notice}</p>}
        {card.question && <p className="text-secondary font-semibold text-ink">{card.question}</p>}
        {options.length > 0 && (
          <div className="flex flex-col gap-1">
            {options.map((option, index) => (
              <button key={option.action} type="button" disabled={option.disabled}
                className={`flex min-h-7 cursor-pointer items-baseline gap-2 rounded-[3px] border px-2 py-1 text-left text-compact font-semibold outline-none transition-colors disabled:cursor-default disabled:opacity-50 ${optionClass[option.tone]}`}
                onClick={() => onChoose(option)}>
                <span aria-hidden="true" className="w-3 shrink-0 font-mono opacity-70">{index + 1}</span>
                <span className="min-w-0">
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
