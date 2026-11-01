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
  | 'dismiss'

export type StepOption = {
  action: StepAction
  label: string
  hint?: string
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
  /** A historical preview or a read-only inspection: the chat offers no step. */
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
  if (input.readOnly) return null
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
  if (input.view !== 'editing') return null
  if (input.recordScope === null)
    return {
      key: 'scope',
      title: 'Choose Record Scope',
      question: 'Is each Source Document one record, or does it hold many?',
      options: [
        { action: 'scope:records', label: 'Catalog: many records per document', hint: 'Each entry in the document becomes its own record', tone: 'secondary' },
        { action: 'scope:document', label: 'Article: one record per document', hint: 'The whole document becomes one object', tone: 'secondary' },
      ],
    }
  if (!input.run) return null
  const latest = input.latest
  if (latest && (ACTIVE.has(latest.status) || latest.status === 'PAUSED' || latest.status === 'FAILED'))
    return {
      key: `extraction:${latest.extractionId}`,
      title: 'Extraction',
      notice: `${latest.progress ?? 'Working…'}${ACTIVE.has(latest.status) ? '' : '. Resume, retry or stop it above.'}`,
      busy: ACTIVE.has(latest.status),
      options: [],
    }
  if (latest && latest.status === 'COMPLETED' && latest.schemaRevisionId === input.revision.id)
    return latest.toCheck && !input.resultsShown
      ? {
          key: `review:${latest.extractionId}`,
          title: 'Extraction finished',
          question: `Review the ${plural(latest.toCheck, 'value')} to check?`,
          detail: latest.progress ? [['Result', latest.progress]] : undefined,
          options: [{ action: 'review', label: 'Open Results', tone: 'positive' }, notYet],
        }
      : null
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
      { action: 'run', label: 'Yes, run extraction', tone: 'positive', disabled: !input.run.available },
      notYet,
    ],
  }
}
