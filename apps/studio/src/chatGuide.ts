import type { RecordScope } from 'extraction/schema'
import { BATCH_EXTRACTION_SELECTION_LIMIT, PILOT_BATCH_SELECTION_LIMIT, batchExtractionProgress, currentBatch, reviewableMember, type BatchExtraction,
  type BatchExtractionMember, type LatestExtraction } from '../shared/batchExtraction.contract'
import type { ExtractionExecutionStatus } from '../shared/extraction.contract'
import { CHAT_OFFER_LIMIT } from '../shared/schemaChat.contract'
import type { SchemaEditorSnapshot } from './currentSchemaRevision'
import { REVISED_PILOT, guidedWorkflow } from './projectContexts/guidedWorkflow'
import { batchStoppable } from './stopBatchExtraction'
import type { ProjectContextActivitySummary } from './projectContexts/transport'

/** What the researcher can do from a step: the rail chat carries each key out (RailChat.tsx). */
export type StepAction =
  | 'generate'
  | 'stop-generation'
  | 'apply'
  | 'apply-run'
  | 'review-schema'
  | 'continue'
  | 'restart'
  | 'discard'
  | 'scope:records'
  | 'scope:document'
  | 'run'
  | 'review'
  | 'pause'
  | 'resume'
  | 'retry'
  | 'stop'
  | 'stop-batch'
  | 'pilot'
  | 'batch'
  | 'approve'
  | 'open-document'
  | 'export'
  | 'more-documents'
  | 'upload'
  | 'skip-more'
  | 'save-corrections'
  | 'discard-corrections'
  | 'dismiss'

export type StepOption = {
  action: StepAction
  label: string
  hint?: string
  /** Said as the option's title and description, not its name: what it does or why it waits. */
  description?: string
  /** Positive commits (one per step), secondary, destructive, or the way past the step (`dismiss`): a line to type in,
   *  its label the prompt. What is typed there is sent as a message of the conversation; Esc sets the step aside unsaid. */
  tone: 'positive' | 'secondary' | 'danger' | 'dismiss'
  disabled?: boolean
  /** Acts on the documents ticked in the step's picker: its label says their count where it reads `{n}`; refused with
   *  none ticked or past the limit. */
  picks?: boolean
  /** The document `open-document` opens, on its Extraction in its Batch Extraction. */
  target?: { sourceDocumentId: string; extractionId: string; batchExtractionId: string | null }
}

export type ProjectDocument = { id: string; name: string }

/** The next step the chat offers: a question with numbered options, or a notice while work runs or waits. */
export type StepCard = {
  /** Identifies the step for "Not yet": a dismissed key stays away until the step's key changes. */
  key: string
  title: string
  question?: string
  detail?: readonly (readonly [string, string])[]
  /** Why the step cannot go on, or where its controls are. */
  notice?: string
  error?: string
  /** Work is under way: the card shows a spinner. */
  busy?: boolean
  /** The project's documents to tick for the options that pick them, first ticked `initial`, at most `limit`. */
  picker?: { documents: readonly ProjectDocument[]; initial: readonly string[]; limit: number }
  options: readonly StepOption[]
  /** A review step's next document to review after this one, for Results' Mark as reviewed dialog. */
  following?: ReviewFollowing
}

/** The next document waiting for review, by name, and where opening it goes. */
export type ReviewFollowing = { name: string; target: NonNullable<StepOption['target']> }

/** The project around the open document, where the host knows it: its workflow's next step is the chat's too. */
export type ProjectGuideInput = {
  summary: ProjectContextActivitySummary
  /** The project's Source Documents, in its order. */
  documents: readonly ProjectDocument[]
  currentDocumentId: string
  /** The project's Batch Extractions; null until read. */
  batches: readonly BatchExtraction[] | null
  /** Each document's latest Extraction as the project's summary counts it, its most recently reviewed one, and the
   *  newest each document shows (any state); null until read. */
  latest: { extractions: readonly LatestExtraction[]; reviewed: readonly LatestExtraction[]; newest: readonly string[] } | null
  /** The Batch Extraction (a pilot round, or a batch) this document was opened from to review, if any. */
  roundId: string | null
  /** A batch start or an approval is under way. */
  busy: boolean
  /** Why the last batch start failed. */
  error: string | null
  /** Before the first approval, after the first trial is reviewed, the chat offers a second trial on more documents:
   *  `ask` until answered, `adding` once the researcher chose it, `done` once it ran or was skipped. Undefined where
   *  the host cannot add documents, which goes straight to the approval. */
  moreDocuments?: 'ask' | 'adding' | 'done'
  /** Documents added here are still being uploaded or read. */
  uploading?: boolean
}

export type GuideInput = {
  view: SchemaEditorSnapshot['view']
  /** A generation runs: the first (`view` is generating) or a regeneration while the saved template stays shown. */
  generating?: boolean
  generationError: string | null
  /** A historical preview or a read-only inspection: the chat offers no schema step; runs follow `run` and `control`. */
  readOnly: boolean
  /** The host generates schemas (Generate schema is offered). */
  canGenerate: boolean
  /** A pre-generation message's reply is on its way. */
  asking: boolean
  instructionCount: number
  sourceDocumentName: string
  proposal: { added: number; removed: number; modified: number; unresolved: readonly string[]; canApply: boolean
    /** A template change for a request to change results (ADR 0037): applying it may also run the extraction. */
    reruns?: boolean } | null
  /** The saved Article/Catalog choice; undefined where the host has none to make. */
  recordScope: RecordScope | null | undefined
  revision: { id: string | null; number: number | null; fieldCount: number }
  /** Run extraction, where the host offers it: why it cannot start now, and whether it can. */
  run: { unavailableReason: string | null; available: boolean } | null
  /** Pause, Resume, Retry and Stop for the latest Extraction, where the host offers them: whether a command is under
   *  way, and why continuing waits (pending inputs) with what it continues with. */
  control: { busy: boolean; continueBlocked: string | null; continueDescription: string; pauseDescription: string } | null
  latest: {
    extractionId: string
    schemaRevisionId: string
    status: ExtractionExecutionStatus
    /** The status line Results shows, e.g. "Reading records · 3 of 14". */
    progress: string | null
    toCheck: number | null
    /** Whether the revision it ran with, when not the current one, defines the same template (fields, record
     *  description and Article/Catalog) as the current revision: compared by the host; null until known. */
    sameTemplate?: boolean | null
  } | null
  /** Results is already in view: a finished run needs no step to open it. */
  resultsShown: boolean
  /** The Template view is already open: the steps after a generation need no way to it. */
  templateShown?: boolean
  /** A generation has just finished and the researcher has not yet chosen to go on: the chat stops at Template ready. */
  templateReady?: boolean
  /** This document's latest Extraction has just completed and the researcher has not yet chosen to go on: the chat stops
   *  at Results ready. */
  resultsReady?: boolean
  dismissed: ReadonlySet<string>
  project?: ProjectGuideInput | null
}

const ACTIVE: ReadonlySet<ExtractionExecutionStatus> = new Set(['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING'])
const notYet: StepOption = { action: 'dismiss', label: 'Something else? Say what to do instead…', tone: 'dismiss' }
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
export const RUN_LABEL = '▶ Run extraction'
export const RERUN_LABEL = '↻ Re-run extraction'

/** The way to the template from the steps that follow its generation, unless it is already in view. */
const viewTemplate = (input: GuideInput): StepOption[] =>
  input.templateShown ? [] : [{ action: 'review-schema', label: 'View template', hint: 'See its fields', tone: 'secondary' }]

/** Why Run cannot start, else what a run does: one record per catalogue entry or for the document, and that a new run
 *  keeps the results and review already saved. */
function runDescription(input: GuideInput, rerun: boolean): string {
  if (input.run?.unavailableReason) return input.run.unavailableReason
  const what = input.recordScope === 'records' ? 'Find the catalogue entries and extract one record per entry'
    : 'Extract one record from the whole document'
  return rerun ? `${what}. A new Extraction: the current results and your review stay saved.` : what
}

/** The latest Extraction while it can still go on: its progress and its controls, the chat being their only place. */
function controlStep(input: GuideInput): StepCard | null {
  const { latest, control } = input
  if (!latest || !control || !(ACTIVE.has(latest.status) || latest.status === 'PAUSED' || latest.status === 'FAILED')) return null
  const stop: StepOption = { action: 'stop', label: '■ Stop', tone: 'danger', disabled: control.busy,
    description: 'Stop the extraction; its saved values and decisions stay' }
  const continuing = (action: 'resume' | 'retry', label: string): StepOption => ({ action, label, tone: 'positive',
    disabled: control.busy || control.continueBlocked !== null, description: control.continueDescription })
  // Halted on an earlier template than the current one: continuing would keep that template, so running the current one
  // again leads, and Resume or Retry follows.
  const halted = latest.status === 'PAUSED' || latest.status === 'FAILED'
  const earlierTemplate = halted && !!input.run && input.revision.id !== null
    && latest.schemaRevisionId !== input.revision.id && latest.sameTemplate !== true
  const restart: StepOption = { action: 'restart', label: '▶ Run again with the current template', tone: 'positive', disabled: control.busy,
    description: `Stops this extraction (its saved values and decisions stay), then runs ${input.revision.number !== null ? `template revision ${input.revision.number}` : 'the current template'}` }
  const lead = (option: StepOption): StepOption[] => earlierTemplate ? [restart, { ...option, tone: 'secondary' }] : [option]
  const options: StepOption[] = latest.status === 'PAUSED' ? [...lead(continuing('resume', '▶ Resume extraction')), stop]
    : latest.status === 'FAILED' ? [...lead(continuing('retry', '↻ Retry extraction')), stop]
      : latest.status === 'QUEUED' || latest.status === 'RUNNING'
        ? [{ action: 'pause', label: '❚❚ Pause extraction', tone: 'secondary', disabled: control.busy, description: control.pauseDescription }, stop]
        // Pausing waits for the call under way; Stop still ends the extraction.
        : latest.status === 'PAUSING' ? [stop] : []
  return {
    key: `extraction:${latest.extractionId}`,
    title: 'Extraction',
    notice: latest.status === 'PAUSING' ? 'Pausing…' : latest.status === 'STOPPING' ? 'Stopping…' : latest.progress ?? 'Working…',
    question: earlierTemplate ? `It ran with an earlier template. ${latest.status === 'FAILED' ? 'Retry' : 'Resume'} keeps that one; run the current template instead?` : undefined,
    error: latest.status === 'PAUSED' || latest.status === 'FAILED' ? control.continueBlocked ?? undefined : undefined,
    busy: ACTIVE.has(latest.status),
    options,
  }
}

/**
 * The step the chat offers next, worked out from the workspace's state alone: choose Article or Catalog, generate a
 * schema for it, review a proposal, run the extraction, follow it, then review its values. The model never chooses a
 * step: a message is answered, proposes a schema change (ADR 0023) or asks for what a step or dialog offers (ADR 0034), and
 * every action is still the researcher's, chosen from a step's options or with a "yes" said beside the step.
 */
export function nextStep(input: GuideInput): StepCard | null {
  const step = currentStep(input)
  return step && !input.dismissed.has(step.key) ? step : null
}

/** The step shown beside a message the researcher sends, and the documents ticked in it then (ADR 0034). */
export type ChatOffer = { card: StepCard; picked: readonly string[] }

/** What the chat offers as the model reads it beside a message: the step's title and its question (or notice). */
export const offerText = (card: StepCard) => {
  const question = card.question ?? card.notice
  return `${card.title}${question ? `: ${question}` : ''}`.slice(0, CHAT_OFFER_LIMIT)
}

/** Stops that sending a message sets aside for good (RailChat's setAside): their options only open a view or go on, so
 *  the step as it was stands for them. */
const SET_ASIDE_STOPS = ['template-ready:', 'results-ready:']

/**
 * What a message that agreed to the step it was sent beside (`card`, as it was then) goes ahead with: the step's lead
 * option as the step stands now, read again from the workspace's state; the step as it was for a stop that sending set
 * aside. Null when the step has moved on or offers nothing to go ahead with.
 */
export function confirmedOption(input: GuideInput, card: StepCard): { card: StepCard; option: StepOption } | null {
  const extract = /^extract:(\d+)$/.exec(card.key)
  const now = extract ? extractStep(input, Number(extract[1])) : currentStep(input)
  const step = now?.key === card.key ? now : SET_ASIDE_STOPS.some((prefix) => card.key.startsWith(prefix)) ? card : null
  const option = step?.options.find(({ tone, disabled }) => tone === 'positive' && !disabled)
  return step && option ? { card: step, option } : null
}

/** While this document's review waits, the next document waiting after it, whether or not its step is set aside. */
export function reviewFollowing(input: GuideInput): ReviewFollowing | null {
  const step = currentStep(input)
  return step?.key.startsWith('review:') ? step.following ?? null : null
}

function currentStep(input: GuideInput): StepCard | null {
  // An older Extraction or revision shown read-only takes no schema step; a run is still the host's to allow. The
  // open document's own run goes on before anything else; then the project's workflow leads, then this document.
  return (input.readOnly ? null : schemaStep(input)) ?? controlStep(input) ?? resultsReadyStep(input) ?? projectStep(input)
    ?? runStep(input)
}

/** Each completed run stops here before the workflow goes on: look at its results, or go on to the next step. */
function resultsReadyStep(input: GuideInput): StepCard | null {
  const { latest } = input
  if (!input.resultsReady || !latest || latest.status !== 'COMPLETED') return null
  const toCheck = latest.toCheck ?? 0
  return {
    key: `results-ready:${latest.extractionId}`,
    title: 'Results ready',
    question: input.resultsShown ? 'Continue once the results look right.'
      : toCheck ? `Look at the results? ${plural(toCheck, 'value')} to check.` : 'Look at the results before going on?',
    detail: latest.progress ? [['Result', latest.progress]] : undefined,
    options: [
      ...input.resultsShown ? [] : [{ action: 'review', label: 'Open Results', tone: 'positive' } as const],
      { action: 'continue', label: 'Continue', tone: input.resultsShown ? 'positive' : 'secondary' },
      notYet,
    ],
  }
}

/**
 * What to extract, once a chat message asked for it (`requested`, ADR 0027): this document alone, or the project's
 * documents ticked here. Studio offers only what may run now: before the template's approval the project's documents
 * run as a pilot of at most PILOT_BATCH_SELECTION_LIMIT, after it as a batch; nothing runs while a batch does.
 */
export function extractStep(input: GuideInput, request: number): StepCard {
  const { run, project } = input
  const options: StepOption[] = []
  if (run)
    options.push({ action: 'run', label: 'Only this document', hint: input.sourceDocumentName, tone: 'secondary',
      disabled: !run.available, description: runDescription(input, input.latest !== null) })
  const schemaReady = input.view === 'editing' && input.recordScope !== null && input.revision.id !== null
  let picker: StepCard['picker']
  if (project && schemaReady) {
    const { summary, documents, batches, currentDocumentId } = project
    const approved = summary.schemaStabilised
    // Approved, every document without a result on the revision yet; before, a pilot from this document on.
    const covered = new Set((batches ?? []).filter((batch) => batch.schemaRevisionId === summary.currentSchemaRevisionId)
      .flatMap((batch) => batch.members.filter((member) => member.completed || member.currentReview).map((member) => member.sourceDocumentId)))
    const initial = approved
      ? documents.map(({ id }) => id).filter((id) => !covered.has(id)).slice(0, BATCH_EXTRACTION_SELECTION_LIMIT)
      : [currentDocumentId, ...documents.map(({ id }) => id).filter((id) => id !== currentDocumentId)].slice(0, 3)
    picker = { documents, initial, limit: approved ? BATCH_EXTRACTION_SELECTION_LIMIT : PILOT_BATCH_SELECTION_LIMIT }
    options.push({ action: approved ? 'batch' : 'pilot', label: 'Documents in this project · {n}', tone: 'positive', picks: true,
      hint: approved ? undefined : `Until the template is approved, try it on at most ${plural(PILOT_BATCH_SELECTION_LIMIT, 'document')}`,
      disabled: project.busy || summary.runningBatch !== null })
  }
  const blocked = options.every(({ disabled }) => disabled)
  return {
    key: `extract:${request}`,
    title: 'Extract',
    question: 'Which documents should be extracted?',
    notice: !blocked ? undefined : project?.summary.runningBatch ? 'A batch extraction is running: wait for it to finish.'
      : run?.unavailableReason ?? 'Nothing can be extracted until the template is ready.',
    error: project?.error ?? undefined,
    picker,
    options: [...options, notYet],
  }
}

/**
 * The changes a chat message proposed to the results (ADR 0035), each value's as it is and as it would be, until the
 * researcher saves or discards them. `lines` are the changes as `correctionLine` gives them.
 */
export function correctionStep(request: number, lines: readonly (readonly [string, string])[], saving: boolean): StepCard {
  const count = lines.length
  return {
    key: `correct:${request}`,
    title: 'Change results',
    question: count === 1 ? 'Save this change to the results?' : `Save these ${count} changes to the results?`,
    detail: lines,
    busy: saving,
    options: [
      { action: 'save-corrections', label: count === 1 ? 'Save the change' : `Save ${count} changes`, tone: 'positive', disabled: saving,
        description: 'Saved as your corrections of these values, as editing them in Results does; they guide later extractions only once you include them.' },
      { action: 'discard-corrections', label: 'Discard', tone: 'secondary', disabled: saving },
      notYet,
    ],
  }
}

/**
 * The project's next step (guidedWorkflow, the server's phase): pilot the schema on a few documents, review the pilot,
 * approve the schema, extract the rest, review the results. Starting, approving and opening the next document to
 * review all happen here, so no other place leads the workflow.
 */
function projectStep(input: GuideInput): StepCard | null {
  const project = input.project
  if (!project) return null
  const { summary, documents, batches, currentDocumentId } = project
  const workflow = guidedWorkflow(summary)
  if (workflow.waiting) {
    const running = (batches ?? []).filter(batchStoppable)
    return { key: 'project-running', title: 'Batch extraction', notice: workflow.waiting, busy: true, error: project.error ?? undefined,
      options: running.length === 0 ? [] : [{ action: 'stop-batch', label: '■ Stop batch extraction', tone: 'danger', disabled: project.busy,
        description: 'Stop every document still being extracted; finished ones keep their results' }] }
  }
  const schemaReady = input.view === 'editing' && input.recordScope !== null && input.revision.id !== null
  // A schema saved here moves the phase on before the project's summary is read again.
  const next = workflow.next?.step === 'schema' && schemaReady ? { step: 'pilot' as const, label: 'Try template on a few documents', action: 'pilot' as const } : workflow.next
  // Every document extracted and reviewed: what is left is the dataset.
  if (!next) return exportStep(project)
  const revisionId = summary.currentSchemaRevisionId
  if (next.step === 'pilot' && next.action === 'pilot') {
    // A round of this revision with values to review leads before another pilot: a revision piloted after the server's
    // phase reached the approval has no phase of its own to say so.
    const review = reviewStep(input, project, (batch) => batch.schemaRevisionId === revisionId)
    if (review) return review
    if (!schemaReady) return null
    const initial = [currentDocumentId, ...documents.map(({ id }) => id).filter((id) => id !== currentDocumentId)]
      .filter((id) => documents.some((document) => document.id === id)).slice(0, 3)
    return {
      key: `pilot:${input.revision.id}`,
      title: next.label === REVISED_PILOT ? next.label : 'Try template on a few documents',
      question: `Check the results on a few before extracting all ${plural(documents.length, 'document')}?`,
      detail: [['Template', `${input.revision.number !== null ? `revision ${input.revision.number} · ` : ''}${plural(input.revision.fieldCount, 'field')}`]],
      error: project.error ?? undefined,
      picker: { documents, initial, limit: PILOT_BATCH_SELECTION_LIMIT },
      options: [
        { action: 'pilot', label: 'Try on {n}', tone: 'positive', picks: true, disabled: project.busy },
        ...(input.run ? [{ action: 'run', label: 'Only this document', hint: 'One Extraction here, without trying other documents', tone: 'secondary',
          disabled: !input.run.available, description: runDescription(input, input.latest !== null) } as const] : []),
        ...viewTemplate(input),
        notYet,
      ],
    }
  }
  if (next.step === 'pilot' || next.step === 'review')
    // Every round's review counts, of an older template too, as the project page's count of results to review does.
    return reviewStep(input, project, () => true)
  if (next.step === 'approve') {
    const approve = { action: 'approve', label: next.label, disabled: project.busy || !revisionId } as const
    // The server's phase turns to the approval at the pilot's first review: the round's review leads, with the approval
    // beside it, since a member re-run since can never be reviewed.
    return reviewStep(input, project, (batch) => batch.schemaRevisionId === revisionId, { ...approve, tone: 'secondary' })
      ?? (next.label === 'Approve template' ? moreDocumentsStep(project, revisionId) : null) ?? {
      key: `approve:${revisionId}`,
      title: next.label,
      question: next.label === 'Re-approve template'
        ? 'The template changed since its approval. Approve the current revision for the whole project?'
        // Unread rounds may still wait for review, and a pilot document's latest Extraction may be its own, unreviewed.
        : `${batches === null || summary.extractedSourceDocumentCount > summary.reviewedSourceDocumentCount ? ''
          : 'Every trial document is reviewed. '}Approve the template for the whole project?`,
      options: [{ ...approve, tone: 'positive' }, notYet],
    }
  }
  if (next.step === 'batch') {
    if (batches === null) return { key: 'batch-reading', title: 'Batch extraction', notice: 'Reading the project’s extractions…', busy: true, options: [] }
    // Every document without a result on the approved revision yet.
    const covered = new Set(batches.filter((batch) => batch.schemaRevisionId === revisionId)
      .flatMap((batch) => batch.members.filter((member) => member.completed || member.currentReview).map((member) => member.sourceDocumentId)))
    const left = documents.filter(({ id }) => !covered.has(id)).map(({ id }) => id)
    return {
      key: `batch:${revisionId}:${left.length}`,
      title: 'Batch extraction',
      question: `Extract ${left.length === documents.length ? 'every document' : `the ${plural(left.length, 'document')} left`} with the approved template?`,
      error: project.error ?? undefined,
      picker: { documents, initial: left.slice(0, BATCH_EXTRACTION_SELECTION_LIMIT), limit: BATCH_EXTRACTION_SELECTION_LIMIT },
      options: [{ action: 'batch', label: 'Extract {n}', tone: 'positive', picks: true, disabled: project.busy }, notYet],
    }
  }
  return null
}

/** The documents with no Extraction on the revision yet, in the project's order: neither in a round of it nor run alone
 *  on it. */
function untried(project: ProjectGuideInput, revisionId: string | null): string[] {
  const tried = new Set([
    ...(project.batches ?? []).filter((batch) => batch.schemaRevisionId === revisionId).flatMap((batch) => batch.members.map((member) => member.sourceDocumentId)),
    ...(project.latest?.extractions ?? []).filter((run) => run.schemaRevisionId === revisionId).map((run) => run.sourceDocumentId),
  ])
  return project.documents.map(({ id }) => id).filter((id) => !tried.has(id))
}

/**
 * The optional second trial, between the first trial's review and the first approval: whether to try the template on
 * more documents; once chosen, the documents not tried yet to tick, or the upload of new ones. Skipping it, or starting
 * it, leads to the approval (after its review).
 */
function moreDocumentsStep(project: ProjectGuideInput, revisionId: string | null): StepCard | null {
  if (project.moreDocuments === undefined || project.moreDocuments === 'done' || project.batches === null) return null
  const left = untried(project, revisionId)
  const skip: StepOption = { action: 'skip-more', label: 'No, go on to approval', tone: 'secondary' }
  if (project.moreDocuments === 'ask')
    return {
      key: `more-documents:${revisionId}`,
      title: 'Try more documents?',
      question: 'Try the template on a few more documents before approving it?',
      options: [{ action: 'more-documents', label: left.length > 0 ? 'Yes, try more documents' : 'Yes, upload more documents', tone: 'positive' },
        skip, notYet],
    }
  const upload: StepOption = { action: 'upload', label: 'Upload documents', tone: left.length > 0 ? 'secondary' : 'positive',
    disabled: project.uploading, description: 'Add PDFs to this project' }
  if (left.length > 0)
    return {
      key: `more-trial:${revisionId}`,
      title: 'Try template on more documents',
      question: 'Which documents should the template be tried on?',
      notice: project.uploading ? 'Reading the new documents…' : undefined,
      error: project.error ?? undefined,
      picker: { documents: project.documents.filter(({ id }) => left.includes(id)), initial: left.slice(0, PILOT_BATCH_SELECTION_LIMIT),
        limit: PILOT_BATCH_SELECTION_LIMIT },
      options: [{ action: 'pilot', label: 'Try on {n}', tone: 'positive', picks: true, disabled: project.busy }, upload,
        { ...skip, label: 'Skip, go on to approval' }, notYet],
    }
  return {
    key: `more-upload:${revisionId}`,
    title: 'Try template on more documents',
    question: project.uploading ? undefined : 'Upload the documents to try the template on.',
    notice: project.uploading ? 'Reading the new documents…' : undefined,
    busy: project.uploading,
    options: [upload, { ...skip, label: 'Skip, go on to approval' }, notYet],
  }
}

type ExportableResult = Pick<LatestExtraction, 'extractionId' | 'sourceRepresentationRevisionId' | 'batchExtractionId' | 'review'>

/** Each document's result to export: only a reviewed one, at its finalized cut, on the Current Template Revision. Its
 *  newest review, as the project's read has it (a run of the document alone included); else, from a server without that
 *  read, its newest reviewed round member, which only offers the export: the export itself refuses without the read. */
export function exportableResults(project: ProjectGuideInput): Map<string, ExportableResult> {
  const results = new Map<string, ExportableResult>()
  const revisionId = project.summary.currentSchemaRevisionId
  if (project.latest) {
    for (const reviewed of project.latest.reviewed)
      if (reviewed.schemaRevisionId === revisionId) results.set(reviewed.sourceDocumentId, reviewed)
    return results
  }
  const newestFirst = (project.batches ?? []).filter((batch) => batch.schemaRevisionId === revisionId)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
  for (const batch of newestFirst)
    for (const { currentReview, ...member } of batch.members)
      if (!results.has(member.sourceDocumentId) && currentReview)
        results.set(member.sourceDocumentId, { ...member, batchExtractionId: batch.batchExtractionId,
          review: { snapshotVersion: currentReview.snapshotVersion, feedbackVersion: currentReview.feedbackVersion } })
  return results
}

/** The finished project's dataset: the documents with a result to tick, then the export's own options and format; or
 *  more documents uploaded, which the project then extracts (the batch step) before they are exported with the rest. */
function exportStep(project: ProjectGuideInput): StepCard | null {
  if (project.batches === null) return null
  const results = exportableResults(project)
  const documents = project.documents.filter(({ id }) => results.has(id))
  if (documents.length === 0) return null
  return {
    key: `export:${project.summary.currentSchemaRevisionId}`,
    title: 'Export results',
    question: 'Every document is extracted and reviewed. Export the results?',
    notice: project.uploading ? 'Reading the new documents…' : undefined,
    error: project.error ?? undefined,
    picker: { documents, initial: documents.map(({ id }) => id), limit: documents.length },
    options: [{ action: 'export', label: 'Export {n}…', tone: 'positive', picks: true, disabled: project.busy,
      description: 'Then choose JSON, Excel or CSV' },
    { action: 'upload', label: 'Upload more documents', tone: 'secondary', disabled: project.uploading,
      description: 'Add PDFs to this project; the template then extracts them for review' }, notYet],
  }
}

/**
 * The review of a round (a Batch Extraction) that counts: the one this document was opened from while it has values
 * waiting, else the newest that has; then the finished runs of a document alone that wait, which no round holds. This
 * document's review if it waits, else the next document after this one. `also` stands beside the review: the
 * approval, in the approve phase.
 */
function reviewStep(input: GuideInput, project: ProjectGuideInput, counts: (run: { schemaRevisionId: string }) => boolean,
  also?: StepOption): StepCard | null {
  if (project.batches === null) return null
  // Only the Extraction a document shows, its newest, can be reviewed: this document's is the one open here.
  const shown = (sourceDocumentId: string, extractionId: string) => sourceDocumentId === project.currentDocumentId && input.latest
    ? input.latest.extractionId === extractionId : project.latest?.newest.includes(extractionId) ?? true
  const waiting = (member: BatchExtractionMember) => reviewableMember(member) && !member.currentReview && shown(member.sourceDocumentId, member.extractionId)
  const opened = project.batches.find((batch) => batch.batchExtractionId === project.roundId)
  const round = opened && counts(opened) && opened.members.some(waiting) ? opened
    : project.batches.filter(counts).toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
      .find((batch) => batch.members.some(waiting))
  const queue = [...(round?.members ?? []).map((member) => ({ ...member, batchExtractionId: round!.batchExtractionId as string | null, waits: waiting(member) })),
    // A run alone of an older template is its document's to run again, not to review.
    ...(project.latest?.extractions ?? []).filter((run) => run.batchExtractionId === null && run.completed && !run.review
      && run.schemaRevisionId === project.summary.currentSchemaRevisionId && counts(run) && shown(run.sourceDocumentId, run.extractionId))
      .map((run) => ({ ...run, currentReview: null, missingCount: null, waits: true }))]
  // The waiting document with the most values found missing, where a review likely finds most to do; of equal counts the
  // first after this one, round the queue. A run alone, whose count is not read, comes after every round member.
  const nextWaiting = (from: number, skip: (sourceDocumentId: string) => boolean) => {
    const around = [...queue.slice(from + 1), ...queue.slice(0, from + 1)].filter(({ waits, sourceDocumentId }) => waits && !skip(sourceDocumentId))
    const most = (entry: (typeof around)[number]) => entry.missingCount ?? -1
    return around.reduce<(typeof around)[number] | undefined>((best, entry) => !best || most(entry) > most(best) ? entry : best, undefined)
  }
  if (!queue.some(({ waits }) => waits)) return null
  // Before the schema's approval every review is its pilot's.
  // The round says whether it was a trial; a document run alone is one before the template's approval.
  const title = (round?.trial ?? !project.summary.schemaStabilised) ? 'Review the trial results' : 'Review results'
  // A member whose document was run again since is that run's to review, never this round's progress.
  const progress = round && batchExtractionProgress(currentBatch(round, project.latest ? new Set(project.latest.newest) : null))
  const detail: [string, string][] | undefined = progress && [['Progress', `${progress.reviewed} of ${plural(progress.reviewable, 'document')} reviewed`]]
  const mine = queue.filter(({ sourceDocumentId }) => sourceDocumentId === project.currentDocumentId)
  const here = mine.find(({ waits }) => waits) ?? mine[0]
  const nameOf = (sourceDocumentId: string) => project.documents.find(({ id }) => id === sourceDocumentId)?.name ?? 'the next document'
  if (here?.waits) {
    // Another document waiting: where saving this review may go on to.
    const after = nextWaiting(queue.indexOf(here), (sourceDocumentId) => sourceDocumentId === project.currentDocumentId)
    return {
      key: `review:${here.extractionId}`,
      title,
      question: input.resultsShown ? undefined : 'Check each value against its source in Results, then mark it as reviewed.',
      notice: input.resultsShown ? 'Check each value against its highlighted source, then mark it as reviewed.' : undefined,
      detail,
      options: [...input.resultsShown ? [] : [{ action: 'review', label: 'Open Results', tone: 'positive' } as const],
        // A run alone keeps its re-run: one that saved no values can never be reviewed.
        ...here.batchExtractionId === null && input.run ? [{ action: 'run', label: RERUN_LABEL, tone: 'secondary', disabled: !input.run.available,
          description: runDescription(input, true) } as const] : [], ...also ? [also] : []],
      following: after && { name: nameOf(after.sourceDocumentId),
        target: { sourceDocumentId: after.sourceDocumentId, extractionId: after.extractionId, batchExtractionId: after.batchExtractionId } },
    }
  }
  const next = nextWaiting(here ? queue.indexOf(here) : -1, () => false)!
  const name = nameOf(next.sourceDocumentId)
  return {
    key: `review-next:${next.extractionId}`,
    title,
    // Not waiting is not reviewed: this document's member may have no values to review, or a newer run of its own.
    question: here?.currentReview ? `This document is reviewed. Open ${name} next?` : `Open ${name} to review its values?`,
    detail,
    options: [{ action: 'open-document', label: `Next document · ${name}`, tone: 'positive',
      target: { sourceDocumentId: next.sourceDocumentId, extractionId: next.extractionId, batchExtractionId: next.batchExtractionId } },
      ...also ? [also] : [], notYet],
  }
}

/** Generating, generating again, a proposal, or the Record Scope: the schema's own next step, if it has one. */
function schemaStep(input: GuideInput): StepCard | null {
  if (input.view === 'generating')
    return { key: 'generating', title: 'Template Suggestion', notice: 'Producing template from the document…', busy: true,
      options: [{ action: 'stop-generation', label: 'Stop generating', tone: 'danger' }] }
  // A regeneration keeps the saved template in view while it runs: the chat offers its Stop all the same.
  if (input.view === 'editing' && input.generating)
    return { key: 'generating', title: 'Template Suggestion', notice: 'Producing a new template from the document; the current one stays until it is ready…',
      busy: true, options: [{ action: 'stop-generation', label: 'Stop generating', tone: 'danger' }] }
  if (input.view === 'empty' || input.view === 'failed') {
    if (!input.canGenerate) return null
    // Article or Catalog first: it says what one record of the template is, so the suggestion is made for it.
    if (input.recordScope === null) return scopeStep(input, 'first')
    const kept = input.instructionCount > 0 ? ` (${plural(input.instructionCount, 'instruction')})` : ''
    const other = input.recordScope === 'records' ? 'document' : 'records'
    return {
      // A new instruction asks again after "Not yet".
      key: `generate:${input.instructionCount}`,
      title: 'Generate template',
      question: input.view === 'failed' ? 'Try generating the template again?' : `Suggest a template from ${input.sourceDocumentName}?`,
      detail: [
        ...input.recordScope ? [['Strategy', strategyName(input.recordScope)] as const] : [],
        ['Instructions', input.instructionCount > 0 ? `${input.instructionCount} kept for generation` : 'none yet'],
      ],
      error: input.view === 'failed' ? input.generationError ?? undefined : undefined,
      options: [
        { action: 'generate', label: `Generate template${kept}`, tone: 'positive', disabled: input.asking },
        ...input.recordScope ? [{ action: `scope:${other}`, label: `Use ${strategyName(other)} instead`, tone: 'secondary' } as const] : [],
        // Not like this: say how, in the step itself.
        { ...notYet, label: 'Tell me what to focus on, or ask about the document…' },
      ],
    }
  }
  if (input.proposal) {
    const { added, removed, modified, unresolved, canApply, reruns } = input.proposal
    const counts = [added && `+${added} added`, removed && `−${removed} removed`, modified && `~${modified} changed`].filter(Boolean).join(' · ')
    // A change for a request to change results is applied and run in one choice; the run still waits for it (ADR 0037).
    const run = reruns && input.run ? input.run : null
    return {
      key: 'proposal',
      title: 'Proposed template change',
      question: run ? 'Apply these changes and extract again?' : 'Apply these changes to the template?',
      detail: [['Changes', counts || 'none']],
      notice: unresolved.length > 0 ? unresolved.join(' ') : undefined,
      options: [
        // While no run can start, applying alone leads.
        ...run ? [{ action: 'apply-run', label: 'Apply and extract again', tone: run.available ? 'positive' : 'secondary', disabled: !canApply || !run.available,
          description: run.unavailableReason ?? 'Saves the template and extracts this document again.' } as const] : [],
        { action: 'apply', label: run ? 'Apply only' : 'Apply changes', tone: run?.available ? 'secondary' : 'positive', disabled: !canApply },
        { action: 'review-schema', label: 'Review in the Template view', hint: 'Accept or reject each change', tone: 'secondary' },
        { action: 'discard', label: 'Discard', tone: 'danger' },
      ],
    }
  }
  // Each generation stops here before anything runs: look at the template, or go on to its next step.
  if (input.view === 'editing' && input.templateReady)
    return {
      key: `template-ready:${input.revision.id ?? 'unsaved'}`,
      title: 'Template ready',
      question: input.templateShown ? 'Continue once the template looks right.' : 'Look at the template before going on?',
      detail: [['Template', plural(input.revision.fieldCount, 'field')],
        ...input.recordScope ? [['Strategy', input.recordScope === 'records' ? 'Catalog' : 'Article'] as const] : []],
      options: [
        ...viewTemplate(input).map((option) => ({ ...option, tone: 'positive' as const })),
        { action: 'continue', label: 'Continue', tone: input.templateShown ? 'positive' : 'secondary' },
        { ...notYet, label: 'Or describe a change to the template…' },
      ],
    }
  // A template made before the choice (imported, or suggested for several documents) still needs it before a run.
  if (input.view === 'editing' && input.recordScope === null) return scopeStep(input, 'template')
  return null
}

const strategyName = (scope: RecordScope) => scope === 'records' ? 'Catalog' : 'Article'

/** Article or Catalog: before the first template (`first`), or for a template that has none yet. */
function scopeStep(input: GuideInput, when: 'first' | 'template'): StepCard {
  return {
    key: when === 'first' ? 'scope:first' : 'scope',
    title: 'Choose Record Scope',
    question: 'Is each Source Document one record, or does it hold many?',
    ...when === 'template' && input.view === 'editing' ? { detail: [['Template', plural(input.revision.fieldCount, 'field')]] as const } : {},
    options: [
      { action: 'scope:records', label: 'Catalog: many records per document', hint: 'Each entry in the document becomes its own record', tone: 'secondary' },
      { action: 'scope:document', label: 'Article: one record per document', hint: 'The whole document becomes one object', tone: 'secondary' },
      ...when === 'template' ? viewTemplate(input) : [],
    ],
  }
}

/** Why the chat offers to run again: how the last run ended, unless it finished, and whether the template changed since,
 *  said only once compared (`unknown`: another revision, not yet known to define another template). */
function rerunQuestion(status: ExtractionExecutionStatus, template: 'same' | 'changed' | 'unknown'): string {
  const ended = status === 'STOPPED' ? 'The last extraction was stopped' : status === 'FAILED' ? 'The last extraction failed'
    : status === 'PAUSED' ? 'The last extraction is paused' : null
  if (ended)
    return template === 'same' ? `${ended}. Run it again?`
      : template === 'changed' ? `${ended}, and the template changed since. Run it again?`
        : `${ended}, and it used another template revision. Run it again?`
  return template === 'changed' ? 'The template changed since the last run. Run the extraction again?'
    : 'The last run used another template revision. Run the extraction again?'
}

/** The latest run's controls while it can go on, else a run (again) of the schema and what a finished one left. */
function runStep(input: GuideInput): StepCard | null {
  const control = controlStep(input)
  if (control) return control
  // Before a schema is ready, or before its scope is chosen, its own steps lead; there is nothing to run yet.
  if (input.view !== 'editing' || !input.run || (!input.readOnly && input.recordScope === null)) return null
  const latest = input.latest
  // The template the last run used is the current one: its revision, or another revision defining the same template.
  const sameTemplate = latest !== null && (latest.schemaRevisionId === input.revision.id || latest.sameTemplate === true)
  // Finished on this template: what is left to check, and a new run of it, stay here (no "Not yet": the chat is the
  // only place to re-run).
  if (latest && latest.status === 'COMPLETED' && sameTemplate) {
    const toCheck = latest.toCheck && !input.resultsShown ? latest.toCheck : 0
    return {
      key: `finished:${latest.extractionId}`,
      title: 'Extraction finished',
      question: toCheck ? `Review the ${plural(toCheck, 'value')} to check?` : undefined,
      detail: latest.progress ? [['Result', latest.progress]] : undefined,
      notice: input.run.unavailableReason ?? undefined,
      options: [
        ...(input.resultsShown ? [] : [{ action: 'review', label: 'Open Results', tone: toCheck ? 'positive' : 'secondary' } as const]),
        { action: 'run', label: RERUN_LABEL, tone: 'secondary', disabled: !input.run.available, description: runDescription(input, true) },
      ],
    }
  }
  const rerun = latest !== null
  const template = !latest || sameTemplate ? 'same' : latest.sameTemplate === false ? 'changed' : 'unknown'
  const run: StepOption = { action: 'run', label: rerun ? RERUN_LABEL : RUN_LABEL, tone: 'positive', disabled: !input.run.available,
    description: runDescription(input, rerun) }
  // Another template than the last run's: look at it before running again, unless it is already in view.
  const look = template === 'same' ? [] : viewTemplate(input).map((option) => ({ ...option, tone: 'positive' as const }))
  return {
    // "Not yet" holds until another Extraction starts.
    key: `run:${latest?.extractionId ?? 'first'}`,
    title: rerun ? 'Run extraction again' : 'Run extraction',
    question: latest ? rerunQuestion(latest.status, template) : `Run the extraction on ${input.sourceDocumentName}?`,
    detail: [
      ['Template', `${input.revision.number !== null ? `revision ${input.revision.number} · ` : ''}${plural(input.revision.fieldCount, 'field')}`],
      ['Strategy', input.recordScope === 'records' ? 'Catalog' : 'Article'],
    ],
    notice: input.run.unavailableReason ?? undefined,
    options: look.length > 0 ? [...look, { ...run, tone: 'secondary' }, notYet] : [run, ...viewTemplate(input), notYet],
  }
}
