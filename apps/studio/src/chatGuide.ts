import type { RecordScope } from 'extraction/schema'
import type { ExtractionExecutionStatus } from '../shared/extraction.contract'
import type { SchemaEditorSnapshot } from './currentSchemaRevision'

/** What the researcher can do from a step: the rail chat carries each key out (RailChat.tsx). */
export type StepAction =
  | 'generate'
  | 'stop-generation'
  | 'apply'
  | 'review-schema'
  | 'discard'
  | 'scope:records'
  | 'scope:document'
  | 'run'
  | 'review'
  | 'pause'
  | 'resume'
  | 'retry'
  | 'stop'
  | 'dismiss'

export type StepOption = {
  action: StepAction
  label: string
  hint?: string
  /** Said as the option's title and description, not its name: what it does or why it waits. */
  description?: string
  /** Positive commits (one per step), secondary, destructive, or the "Not yet" that dismisses the step. */
  tone: 'positive' | 'secondary' | 'danger' | 'dismiss'
  disabled?: boolean
}

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
  options: readonly StepOption[]
}

export type GuideInput = {
  view: SchemaEditorSnapshot['view']
  generationError: string | null
  /** A historical preview or a read-only inspection: the chat offers no schema step; runs follow `run` and `control`. */
  readOnly: boolean
  /** The host generates schemas (Generate schema is offered). */
  canGenerate: boolean
  /** A pre-generation message's reply is on its way. */
  asking: boolean
  instructionCount: number
  sourceDocumentName: string
  proposal: { added: number; removed: number; modified: number; unresolved: readonly string[]; canApply: boolean } | null
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
  } | null
  /** Results is already in view: a finished run needs no step to open it. */
  resultsShown: boolean
  dismissed: ReadonlySet<string>
}

const ACTIVE: ReadonlySet<ExtractionExecutionStatus> = new Set(['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING'])
const notYet: StepOption = { action: 'dismiss', label: 'Not yet', tone: 'dismiss' }
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
export const RUN_LABEL = '▶ Run extraction'
export const RERUN_LABEL = '↻ Re-run extraction'

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
  const options: StepOption[] = latest.status === 'PAUSED' ? [continuing('resume', '▶ Resume extraction'), stop]
    : latest.status === 'FAILED' ? [continuing('retry', '↻ Retry extraction'), stop]
      : latest.status === 'QUEUED' || latest.status === 'RUNNING'
        ? [{ action: 'pause', label: '❚❚ Pause extraction', tone: 'secondary', disabled: control.busy, description: control.pauseDescription }, stop]
        : []
  return {
    key: `extraction:${latest.extractionId}`,
    title: 'Extraction',
    notice: latest.status === 'PAUSING' ? 'Pausing…' : latest.status === 'STOPPING' ? 'Stopping…' : latest.progress ?? 'Working…',
    error: latest.status === 'PAUSED' || latest.status === 'FAILED' ? control.continueBlocked ?? undefined : undefined,
    busy: ACTIVE.has(latest.status),
    options,
  }
}

/**
 * The step the chat offers next, worked out from the workspace's state alone: generate a schema, review a proposal,
 * choose Article or Catalog, run the extraction, follow it, then review its values. The model never chooses a step;
 * a message is answered or proposes a schema change (ADR 0023), and every action goes through a step's options.
 */
export function nextStep(input: GuideInput): StepCard | null {
  const step = currentStep(input)
  return step && !input.dismissed.has(step.key) ? step : null
}

function currentStep(input: GuideInput): StepCard | null {
  // An older Extraction or revision shown read-only takes no schema step; a run is still the host's to allow.
  return (input.readOnly ? null : schemaStep(input)) ?? runStep(input)
}

/** Generating, generating again, a proposal, or the Record Scope: the schema's own next step, if it has one. */
function schemaStep(input: GuideInput): StepCard | null {
  if (input.view === 'generating')
    return { key: 'generating', title: 'Schema Suggestion', notice: 'Producing schema from the document…', busy: true,
      options: [{ action: 'stop-generation', label: 'Stop generating', tone: 'danger' }] }
  if (input.view === 'empty' || input.view === 'failed') {
    if (!input.canGenerate) return null
    const messages = input.instructionCount > 0 ? ` (${plural(input.instructionCount, 'message')})` : ''
    return {
      // A new instruction asks again after "Not yet".
      key: `generate:${input.instructionCount}`,
      title: 'Generate schema',
      question: input.view === 'failed' ? 'Try generating the schema again?' : `Suggest a schema from ${input.sourceDocumentName}?`,
      detail: [['Instructions', input.instructionCount > 0 ? `${plural(input.instructionCount, 'message')} kept` : 'none yet']],
      error: input.view === 'failed' ? input.generationError ?? undefined : undefined,
      options: [
        { action: 'generate', label: `Generate schema${messages}`, tone: 'positive', disabled: input.asking },
        notYet,
      ],
    }
  }
  if (input.proposal) {
    const { added, removed, modified, unresolved, canApply } = input.proposal
    const counts = [added && `+${added} added`, removed && `−${removed} removed`, modified && `~${modified} changed`].filter(Boolean).join(' · ')
    return {
      key: 'proposal',
      title: 'Proposed schema change',
      question: 'Apply these changes to the schema?',
      detail: [['Changes', counts || 'none']],
      notice: unresolved.length > 0 ? unresolved.join(' ') : undefined,
      options: [
        { action: 'apply', label: 'Apply changes', tone: 'positive', disabled: !canApply },
        { action: 'review-schema', label: 'Review in Schema tab', hint: 'Accept or reject each change', tone: 'secondary' },
        { action: 'discard', label: 'Discard', tone: 'danger' },
      ],
    }
  }
  if (input.view === 'editing' && input.recordScope === null)
    return {
      key: 'scope',
      title: 'Choose Record Scope',
      question: 'Is each Source Document one record, or does it hold many?',
      options: [
        { action: 'scope:records', label: 'Catalog: many records per document', hint: 'Each entry in the document becomes its own record', tone: 'secondary' },
        { action: 'scope:document', label: 'Article: one record per document', hint: 'The whole document becomes one object', tone: 'secondary' },
      ],
    }
  return null
}

/** The latest run's controls while it can go on, else a run (again) of the schema and what a finished one left. */
function runStep(input: GuideInput): StepCard | null {
  const control = controlStep(input)
  if (control) return control
  // Before a schema is ready, or before its scope is chosen, its own steps lead; there is nothing to run yet.
  if (input.view !== 'editing' || !input.run || (!input.readOnly && input.recordScope === null)) return null
  const latest = input.latest
  // Finished on this revision: what is left to check, and a new run of it, stay here (no "Not yet": the chat is the
  // only place to re-run).
  if (latest && latest.status === 'COMPLETED' && latest.schemaRevisionId === input.revision.id) {
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
  return {
    // "Not yet" holds until another Extraction starts.
    key: `run:${latest?.extractionId ?? 'first'}`,
    title: rerun ? 'Run extraction again' : 'Run extraction',
    question: rerun ? 'The schema changed since the last run. Run the extraction again?' : `Run the extraction on ${input.sourceDocumentName}?`,
    detail: [
      ['Schema', `${input.revision.number !== null ? `revision ${input.revision.number} · ` : ''}${plural(input.revision.fieldCount, 'field')}`],
      ['Strategy', input.recordScope === 'records' ? 'Catalog' : 'Article'],
    ],
    notice: input.run.unavailableReason ?? undefined,
    options: [
      { action: 'run', label: rerun ? RERUN_LABEL : RUN_LABEL, tone: 'positive', disabled: !input.run.available,
        description: runDescription(input, rerun) },
      notYet,
    ],
  }
}
