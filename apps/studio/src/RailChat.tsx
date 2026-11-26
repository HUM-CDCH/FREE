import { useEffect, useEffectEvent, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { RecordScope } from 'extraction/schema'
import { nodesToTemplate } from 'extraction/schema'
import { countTemplateFields } from '../shared/template'
import type { ChatWhere } from '../shared/schemaChat.contract'
import ChatDrawer from './ChatDrawer'
import { DeleteDialog } from './ui'
import type { SchemaEditorController } from './currentSchemaRevision'
import { confirmedOption, correctionStep, extractStep, rerunOfferStep, nextStep, reviewFollowing, type ChatOffer, type GuideInput, type ProjectGuideInput, type StepAction,
  type StepCard, type StepOption } from './chatGuide'
import { NO_RESULTS_REPLY, type ResultCorrections } from './useResultCorrections'
import { ChatTranscript } from './SchemaChatParts'
import { useSameTemplateAsRun } from './useSameTemplateAsRun'
import { chatMessageClass } from './chatMessageClass'
import { CONVERSATION_EMPTY } from './SchemaPanel'
import { PendingAsk } from './SchemaInstructions'
import { NO_ACTION_REPLY, type SchemaChat } from './useSchemaChat'

/** The reply to a "yes" beside a step with nothing to go ahead with, or one that has moved on since. */
export const NOTHING_TO_CONFIRM_REPLY = 'There is nothing here to go ahead with: choose from the step below, or say what to do.'
const NO_REGENERATE_REPLY = 'The template cannot be generated again here.'
const PRE_SCHEMA_EMPTY = "Ask about the document, or say what to extract. I'll suggest a template when you're ready."

export type RailChatProps = {
  chat: SchemaChat
  schema: SchemaEditorController
  sourceDocumentName: string
  /** Extraction Schema generation; omitted where generation is unavailable. */
  onGenerate?: (instruction: string) => void
  /** Asks to generate the template again once there is one (the Regenerate dialog), where the workspace can. */
  onRegenerate?: () => void
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
    /** Opens the project page, where an approved template's batch is extracted, reviewed and exported (ADR 0041). */
    openProject: () => void
    /** The project's identity, which keeps whether the researcher is trying the template on more documents. */
    id?: string
    /** Adds PDFs to the project, where the workspace can: the upload of the trial on more documents. */
    addDocuments?: (files: readonly File[]) => void
  } | null
  /** The chat's corrections of the result Results shows (ADR 0035), where the workspace has one to correct. */
  corrections?: ResultCorrections | null
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
   *  composer; a reply shows above the composer, and the conversation's dot returns to the home. */
  mode?: 'full' | 'step'
  /** While this document's review waits, the next document waiting after it, and opening it; null when none. */
  onReviewFollowing?: (following: NextReview | null) => void
}

/** The composer's hint while a result is shown, whose values a message can change too. */
const RESULTS_HINT = 'Describe a change to the results or the template…'

/** The next document to review, as Results' Mark as reviewed dialog offers it. */
export type NextReview = { name: string; open: () => void }

/**
 * The workspace's chat, the rail's home: the schema chat's conversation (instructions and answers before the first
 * schema, edit requests and proposals after) and the next step with its numbered options. Under another rail view the
 * next step and the composer stay in view, so the way on is always the chat's.
 */
export default function RailChat({ chat, schema, sourceDocumentName, onGenerate, onRegenerate, recordScope, run = null, corrections = null, control = null, project = null, latest, readOnly = false, resultsShown = false, templateShown = false, onShowView, mode = 'full', onReviewFollowing }: RailChatProps) {
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
  // Whether the researcher chose to try the template on more documents, kept with the project in this browser so
  // another document goes on with it.
  const moreKey = project?.id ? `free.more-documents.${project.id}` : null
  const [more, setMoreState] = useState(() => ({ key: moreKey, value: storedMore(moreKey) }))
  if (more.key !== moreKey) setMoreState({ key: moreKey, value: storedMore(moreKey) })
  const setMore = (value: MoreDocuments) => {
    setMoreState({ key: moreKey, value })
    try { if (moreKey) localStorage.setItem(moreKey, value) } catch { /* kept for this page only */ }
  }
  // The upload's file input, held as state: a choice clicks it, and a ref may not be read where choices are made.
  const [fileInput, setFileInput] = useState<HTMLInputElement | null>(null)
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
      reruns: chat.proposalReruns,
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
    project: project ? { ...project.guide, moreDocuments: more.value, canUpload: !!project.addDocuments } : null,
  }
  // Results offers to mark the review and go on to the next document: which one, as the review step has it.
  const following = project ? reviewFollowing(guide) : null
  const publishFollowing = useEffectEvent(() => {
    onReviewFollowing?.(following && project ? { name: following.name, open: () => project.open(following.target) } : null)
  })
  const followingKey = following ? `${following.target.extractionId}:${following.name}` : null
  useEffect(() => { publishFollowing() }, [followingKey])
  useEffect(() => () => onReviewFollowing?.(null), [onReviewFollowing])
  // Where a message is said (ADR 0040): a message that could change the template or the results shown is read as a
  // change to the one the researcher looks at.
  const where: ChatWhere = { view: resultsShown ? 'results' : templateShown ? 'template' : 'chat', results: !!corrections?.available }
  // Changes a message proposed to the results wait for the researcher first, as the latest message's answer (ADR 0035).
  const proposed = corrections?.pending ?? null
  const correcting = proposed && correctionStep(proposed.request, proposed.proposal.corrections.length, corrections?.busy === 'saving')
  // What the values could not meet but the template holds is offered as a new run, after the changes (ADR 0042).
  const offeredRun = corrections?.rerun && !readOnly ? rerunOfferStep(guide, corrections.rerun.request, corrections.rerun.reason) : null
  // A message that asked to extract is answered by its own step until the researcher chooses; else the next step.
  const next = correcting && !dismissed.has(correcting.key) ? correcting
    : offeredRun && !dismissed.has(offeredRun.key) ? offeredRun
      : chat.extractRequest !== null && !readOnly ? extractStep(guide, chat.extractRequest) : nextStep(guide)
  // Finish answering the researcher before asking for scope; an edit may produce a proposal to review first.
  const step = next?.key === 'scope' && (chat.loading || chat.asking !== null) ? null : next
  // The documents ticked in the step's picker: its own initial ones until the researcher changes them.
  const [ticked, setTicked] = useState<{ key: string; ids: ReadonlySet<string> } | null>(null)
  const picked = step?.picker ? (ticked?.key === step.key ? ticked.ids : new Set(step.picker.initial)) : null

  // Run again with the current template: the halted Extraction is stopped first, and once it has stopped (and a run may
  // start) the current template runs. Anything else becoming of it drops the request.
  const [restartFor, setRestartFor] = useState<string | null>(null)
  if (restartFor !== null && (latest?.extractionId !== restartFor || !['PAUSED', 'FAILED', 'STOPPING', 'STOPPED'].includes(latest.status)))
    setRestartFor(null)
  const restarted = useRef<string | null>(null)
  const restartReady = restartFor !== null && latest?.extractionId === restartFor && latest.status === 'STOPPED' && !!run?.available
  useEffect(() => {
    // Once per request: the new run replaces the stopped one as the latest, which ends the request.
    if (!restartReady || !run || restarted.current === restartFor) return
    restarted.current = restartFor
    run.start()
  }, [restartReady, restartFor, run])

  // The step a message is sent beside, with its ticks, which a "yes" goes ahead with (ADR 0034).
  const offer = (card: StepCard | null): ChatOffer | null => card && { card, picked: picked ? [...picked] : [] }

  function choose(card: StepCard, option: StepOption, text = '', ticks: ReadonlySet<string> | null = picked) {
    const ids = option.picks && card.picker && ticks ? card.picker.documents.map(({ id }) => id).filter((id) => ticks.has(id)) : []
    if (option.disabled || (option.picks && !pickable(card, ids.length))) return
    // A choice made under another view leaves the view as it is; the next step shows there, folded above the composer.
    // Past the step, something else said instead: the message itself joins the conversation, which answers it.
    const said = option.action === 'dismiss' ? text.trim() : ''
    if (said) {
      if (!canSay) return
      sentHere()
      void (preSchema ? chat.ask(said, offer(card)) : chat.send(said, offer(card), where))
    } else {
      // Only a choice that does something is noted in the conversation.
      if (!UNNOTED.has(option.action)) chat.appendStep(card.title, option.picks ? pickedLabel(option, ids.length) : option.label)
      // Every option turned down and nothing said instead: no action, so point to the chat box.
      if (option.action === 'dismiss') chat.appendMessage(NO_ACTION_REPLY)
    }
    // Template ready waits for a way on: viewing the template keeps it, any other choice ends it.
    if (card.key.startsWith('template-ready:') && option.action !== 'review-schema') setTemplateReady(false)
    // Results ready likewise: opening Results keeps it, any other choice ends it.
    if (card.key.startsWith('results-ready:') && option.action !== 'review') setResultsReady(null)
    // The extract step answers one request: any choice ends it.
    if (card.key.startsWith('extract:')) {
      chat.clearExtractRequest()
      if (option.action === 'dismiss') return
    }
    // Proposed changes set aside unsaid are discarded; with something said instead they wait, so a "yes" can save them.
    if (card.key.startsWith('correct:') && option.action === 'dismiss' && !said) corrections?.discard()
    // The offered run answers one request: running, or setting it aside unsaid, ends it.
    if (card.key.startsWith('rerun-offer:') && !said) corrections?.dismissRerun?.()
    const act: Record<StepAction, () => void> = {
      generate: () => onGenerate?.(instructions.text),
      'stop-generation': () => schema.cancelGeneration(),
      apply: () => { chat.apply() },
      // The run saves the applied template first, as Run does (ADR 0037); a refused Apply runs nothing.
      'apply-run': () => { if (chat.apply()) run?.start() },
      'review-schema': () => onShowView('schema'),
      continue: () => {},
      restart: () => {
        setRestartFor(latest?.extractionId ?? null)
        control?.command('stop')
      },
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
      pilot: () => {
        // The trial on more documents starts: after its review the chat asks for the approval again.
        if (card.key.startsWith('more-trial:')) setMore('ask')
        project?.start('pilot', ids)
      },
      'more-documents': () => setMore('adding'),
      upload: () => fileInput?.click(),
      'skip-more': () => setMore('ask'),
      'save-corrections': () => void corrections?.save(),
      'discard-corrections': () => corrections?.discard(),
      approve: () => project?.approve(),
      'open-document': () => option.target && project?.open(option.target),
      'open-project': () => project?.openProject(),
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
  // A message sent from another view leaves that view as it is: a line above the composer says it is being answered,
  // then shows the reply, which opens the conversation on a click.
  const [sentFrom, setSentFrom] = useState<number | null>(null)
  if (mode === 'full' && sentFrom !== null) setSentFrom(null)
  const sentHere = () => { if (mode === 'step') setSentFrom(chat.messages.length) }
  const proposing = corrections?.busy === 'proposing'
  const working = chat.loading || chat.asking !== null || proposing
  const reply = sentFrom === null ? undefined : chat.messages.slice(sentFrom).findLast((message) => message.role === 'assistant')
  const sentLine = mode === 'step' && sentFrom !== null && (working ? (
    <p role="status" className="m-0 flex items-center gap-2 text-compact text-ink-muted">
      <span aria-hidden="true" className="size-3 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-ink" />
      {proposing ? 'Reading the results for the changes…' : 'Working on it…'}
      {proposing && <button type="button" onClick={corrections?.stop} className="cursor-pointer rounded-md px-1 text-ink-muted outline-none hover:text-danger">Stop</button>}
    </p>
  ) : reply && 'text' in reply && (
    <button type="button" onClick={() => onShowView('chat')} title="Show conversation"
      className="cursor-pointer rounded-md text-left text-compact leading-snug text-ink-muted outline-none hover:text-ink focus-visible:text-ink">
      <span className="line-clamp-2 [overflow-wrap:anywhere]">{reply.text}</span>
    </button>
  ))
  // A step with a way past it carries the composer as its last numbered option: sending from it says something else
  // instead, so it sets the step aside as choosing that option does.
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const sayOption = step?.options.find((option) => option.action === 'dismiss')
  // Under another view the step folds to its title line and the composer to one row, so the view keeps the rail's
  // height: the title unfolds the step, and a step that failed is never folded.
  const [unfolded, setUnfolded] = useState<string | null>(null)
  const folded = !!step && mode === 'step' && unfolded !== step.key && !step.error
  const sayInCard = !!step && !!sayOption && !folded
  const setAside = () => {
    if (!sayInCard || !step) return
    if (step.key.startsWith('template-ready:')) setTemplateReady(false)
    if (step.key.startsWith('results-ready:')) setResultsReady(null)
    if (step.key.startsWith('extract:')) chat.clearExtractRequest()
    else setDismissed((current) => new Set(current).add(step.key))
  }
  // The step goes with the message, as it was before sending set it aside.
  const ask = () => { if (!instructions.draft.trim()) return; const offered = offer(step); sentHere(); setAside(); void chat.ask(undefined, offered) }
  const send = () => { if (!chat.input.trim()) return; const offered = offer(step); sentHere(); setAside(); void chat.send(chat.input, offered, where) }

  const blocked = !!pending || chat.loading || !!corrections?.busy
  // What is typed in place of a step goes where the composer's message would.
  const canSay = preSchema ? chat.asking === null : editable && !blocked

  // A message that asked to make the template, or agreed to the step it was sent beside, is carried out as the workspace
  // stands now (ADR 0034): before the first template, Generate template comes back here; after it, the Regenerate
  // dialog opens; a "yes" goes ahead with the step's lead option.
  const { heard, clearHeard, appendMessage } = chat
  // The Generate template step, if it was set aside, comes back.
  const showGenerate = () => setDismissed((current) => new Set([...current].filter((key) => !key.startsWith('generate:'))))
  // Read with the workspace as it stands when the request arrives, not as it stood when the message was sent.
  const carryOut = useEffectEvent((request: NonNullable<typeof heard>) => {
    clearHeard()
    if (request.action === 'generate') {
      if (preSchema) showGenerate()
      else if (onRegenerate) onRegenerate()
      else appendMessage(NO_REGENERATE_REPLY)
      return
    }
    // A change to particular results is proposed for the result Results shows, where there is one (ADR 0035); the
    // proposal itself says when there is none.
    if (request.action === 'correct') {
      if (corrections && request.said) void corrections.propose(request.said.message, request.said.history, where.view)
      else appendMessage(NO_RESULTS_REPLY)
      return
    }
    // A "yes" beside proposed changes saves them, while they are still the ones it was said beside; beside the offered
    // run, it runs.
    const beside = [correcting, offeredRun].find((card) => card && request.offer?.card.key === card.key)
    if (beside) {
      const lead = beside.options.find(({ tone, disabled }) => tone === 'positive' && !disabled)
      if (lead) choose(beside, lead)
      else appendMessage(NOTHING_TO_CONFIRM_REPLY)
      return
    }
    const confirmed = request.offer && confirmedOption(guide, request.offer.card)
    if (confirmed) choose(confirmed.card, confirmed.option, '', new Set(request.offer!.picked))
    else appendMessage(NOTHING_TO_CONFIRM_REPLY)
  })
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the chat's request, carried out once as it arrives
    if (heard) carryOut(heard)
  }, [heard])
  const card = (composer: ReactNode) => step && <StepCardView key={step.key} card={step} scopeDisabled={!!recordScope?.disabled} scopeBlockedReason={snap.editingBlockedReason} sayDisabled={!canSay}
    onChoose={(option) => choose(step, option)} picked={picked} onPick={(ids) => setTicked({ key: step.key, ids })}
    composer={composer} onSay={() => composerRef.current?.focus()} onFold={mode === 'step' ? () => setUnfolded(null) : undefined} />
  // Folded, the step keeps its options beside its title, but for those that need documents ticked or something said.
  const foldedStep = folded && step && (
    <SetAsideStepView label={step.title} title={step.title} busy={step.busy}
      description={recordScope?.disabled && step.options.some(option => option.action.startsWith('scope:')) ? snap.editingBlockedReason : null}
      summary={[step.detail?.[0]?.[1], step.notice].filter(Boolean).join(' · ')} live={!!step.notice}
      expandLabel={`Show the ${step.title} step`} onExpand={() => setUnfolded(step.key)}
      actions={step.options.filter((option) => option.action !== 'dismiss' && !option.picks).map((option) => ({
        label: option.label, name: option.label, title: option.description, tone: option.tone,
        disabled: !!option.disabled || (!!recordScope?.disabled && option.action.startsWith('scope:')), run: () => choose(step, option) }))} />
  )
  // The Generate template step set aside: folded to its title line, generating stays one click away and the title
  // brings the whole step back.
  const generate = !step && preSchema && (
    <SetAsideStepView title="Generate template" summary={instructions.count > 0 ? plural(instructions.count, 'instruction') : 'no instructions'}
      expandLabel="Show the Generate template step"
      onExpand={showGenerate}
      actions={[{ label: 'Generate', name: `Generate template${instructions.countLabel}`, disabled: chat.asking !== null,
        run: () => onGenerate?.(instructions.text) }]} />
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
      // With a result shown, a message may change its values as well as the template (ADR 0035).
      : editable ? corrections?.available ? RESULTS_HINT : 'Describe a change to the template…' : 'The chat continues once the template is ready.'
  const rows = mode === 'step' ? 1 : sayInCard ? 2 : 3
  const composer = preSchema ? (
    <>
      <textarea ref={composerRef} className={composerClass} rows={rows} aria-label={composerHint} placeholder={composerHint} value={instructions.draft}
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
      <textarea ref={composerRef} className={composerClass} rows={rows} aria-label={composerHint} placeholder={composerHint} value={chat.input} disabled={!editable || blocked}
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

  // The instructions and questions show where they were said, in the transcript; a reply still coming follows it.
  const pendingAsk = (chat.asking !== null || chat.askError || corrections?.busy === 'proposing') ? (
    <>
      {chat.asking !== null && <PendingAsk asking={chat.asking} messageClass={chatMessageClass} />}
      {chat.askError && <p className="text-compact text-danger [overflow-wrap:anywhere]" role="alert">{chat.askError}</p>}
      {corrections?.busy === 'proposing' && (
        <p role="status" className="flex items-center gap-2 text-compact text-ink-muted">
          <span aria-hidden="true" className="size-3 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-ink" />
          Reading the results for the changes…
          <button type="button" onClick={corrections.stop} className="cursor-pointer rounded-md px-1 text-ink-muted outline-none hover:text-danger">Stop</button>
        </p>
      )}
    </>
  ) : undefined

  // While a step offers a way past it, the composer is drawn in the card and the drawer has none of its own.
  const shownCard = foldedStep || (step && (sayInCard ? card(composer) : card(null)))
  return (
    <>
      <ChatDrawer open={open} fill={open} onCollapse={() => onShowView('chat')} onExpand={() => onShowView('chat')}
        title="Conversation" label={sentLine || shownCard || generate ? <>{sentLine}{shownCard || generate}</> : undefined} dot={dot} actions={clear || undefined} bodyRef={bodyRef}
        bar={shownCard || generate || undefined} composer={sayInCard ? null : composer}>
        <ChatTranscript chat={chat} empty={preSchema ? PRE_SCHEMA_EMPTY : CONVERSATION_EMPTY} after={pendingAsk} />
      </ChatDrawer>
      {project?.addDocuments && (
        <input ref={setFileInput} className="sr-only" type="file" tabIndex={-1} aria-hidden="true" accept=".pdf,application/pdf" multiple
          data-testid="chat-upload"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ''
            if (files.length) project.addDocuments?.(files)
          }} />
      )}
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

/** The next step, folded or open, is one raised card with one badge, so it is told apart from the conversation and
 *  found again in the same place: tinted where folded (its title line), the same tint heading it when open. */
const STEP_CARD = 'rounded-md border border-accent/30 border-l-[3px] border-l-accent shadow-lift'
function NextStepBadge({ busy = false }: { busy?: boolean }) {
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center gap-1 rounded-[3px] bg-accent-soft px-1.5 py-px text-[10px] font-bold tracking-wide text-accent uppercase">
      {busy && <span className="size-2.5 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />}
      Next step
    </span>
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
/** The choices that leave the rail's view where it is: those that open a view themselves, and a run's controls (and the
 *  export, whose dialog opens over it). Every other choice moves the workflow on and returns to the conversation. */
/** The choices that change nothing, so the conversation does not note them: setting a step aside, going on past a
 *  stop, opening a view or another document, and the export's dialog (the export itself is its own). */
const UNNOTED: ReadonlySet<StepAction> = new Set<StepAction>(['dismiss', 'continue', 'review-schema', 'review', 'open-document', 'open-project', 'upload'])

type MoreDocuments = 'ask' | 'adding'
/** Whether the researcher is trying the template on more documents, kept for a project; `ask` when not, or storage is
 *  unavailable. */
function storedMore(key: string | null): MoreDocuments {
  try {
    const value = key ? localStorage.getItem(key) : null
    return value === 'adding' ? value : 'ask'
  } catch { return 'ask' }
}

/** A step folded to the card's title line (set aside, or under another view): the same card and Next step badge, a
 *  summary, and its actions, which take further lines where the rail is narrow. The title (⌃) brings the whole step back. */
function SetAsideStepView({ title, label = `${title}, set aside`, busy = false, summary, description, live = false, expandLabel, onExpand, actions }: {
  /** `live`: the summary carries the step's notice, announced as it changes. */
  title: string; label?: string; busy?: boolean; summary: string; description?: string | null; live?: boolean; expandLabel: string; onExpand: () => void
  actions: readonly { label: string; name: string; title?: string; tone?: StepOption['tone']; disabled: boolean; run: () => void }[]
}) {
  const descriptionId = useId()
  return (
    <section aria-label={label} className={`mx-4 my-2 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 bg-accent-ghost px-2.5 py-1.5 ${STEP_CARD}`}>
      <button type="button" aria-label={expandLabel} title={expandLabel} onClick={onExpand}
        className="group/open flex max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-[3px] text-left outline-none">
        <NextStepBadge busy={busy} />
        <span className="truncate text-secondary font-bold text-ink group-hover/open:underline">{title}</span>
        <span aria-hidden="true" className="shrink-0 text-compact leading-none text-accent">⌃</span>
      </button>
      {/* Outside the button, whose content is not announced; it also keeps the actions at the line's end. */}
      <span role={live ? 'status' : undefined} title={summary} className="min-w-0 flex-[1_1_4rem] truncate text-compact text-ink-faint">{summary && `· ${summary}`}</span>
      {actions.map((action) => (
        <button key={action.name} type="button" aria-label={action.name} title={action.title ?? action.name} aria-describedby={action.disabled && description ? descriptionId : undefined} disabled={action.disabled} onClick={action.run}
          className={`max-w-full cursor-pointer truncate rounded-[3px] border px-2 py-0.5 text-compact font-semibold outline-none transition-colors disabled:cursor-default disabled:opacity-50 ${optionClass[action.tone ?? 'positive']}`}>
          {action.label}
        </button>
      ))}
      {description && <p id={descriptionId} className="basis-full text-compact leading-snug text-ink-muted">{description}</p>}
    </section>
  )
}

/** The next step: a permission card with numbered options. 1–9 choose while it has focus. A step that acts on
 *  documents lists the project's to tick. The way past it (`dismiss`) is the chat's composer, drawn as the card's last
 *  numbered option: its number focuses it (`onSay`), and sending from it says something else instead and sets the step
 *  aside; Esc, or the header's ×, sets it aside unsaid. */
function StepCardView({ card, scopeDisabled = false, scopeBlockedReason = null, sayDisabled = false, onChoose, picked = null, onPick, composer, onSay, onFold }: {
  card: StepCard; scopeDisabled?: boolean; scopeBlockedReason?: string | null; sayDisabled?: boolean; onChoose: (option: StepOption) => void
  picked?: ReadonlySet<string> | null; onPick?: (ids: ReadonlySet<string>) => void
  composer: ReactNode; onSay: () => void
  /** Under another view: folds the step back to its title line. */
  onFold?: () => void
}) {
  const scopeDescriptionId = useId()
  const scopeDescription = scopeDisabled && card.options.some(option => option.action.startsWith('scope:')) ? scopeBlockedReason : null
  const count = picked?.size ?? 0
  const options = card.options.map((option) =>
    scopeDisabled && option.action.startsWith('scope:') ? { ...option, disabled: true }
      : option.picks ? { ...option, label: pickedLabel(option, count), disabled: option.disabled || !pickable(card, count) } : option)
  const dismiss = options.find(({ action }) => action === 'dismiss')
  return (
    <section aria-label={card.title} className={`mx-4 shrink-0 overflow-hidden bg-surface ${STEP_CARD} ${dismiss ? 'mt-2 mb-3' : 'my-2'}`}
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
      <div className="flex items-center gap-2 border-b border-accent/20 bg-accent-ghost px-2.5 py-1.5">
        <NextStepBadge busy={card.busy} />
        <span className="min-w-0 flex-1 truncate text-secondary font-bold text-ink" title={card.title}>{card.title}</span>
        {onFold && (
          <button type="button" aria-label="Fold the step" title="Fold" onClick={onFold}
            className="shrink-0 cursor-pointer rounded-md px-1 leading-none text-ink-faint outline-none transition-colors hover:bg-surface-muted hover:text-ink">
            <span aria-hidden="true">⌄</span>
          </button>
        )}
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
        {scopeDescription && <p id={scopeDescriptionId} className="text-compact leading-snug text-ink-muted">{scopeDescription}</p>}
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
                aria-describedby={scopeDescription && option.action.startsWith('scope:') ? scopeDescriptionId : undefined}
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
