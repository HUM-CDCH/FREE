import { useId, useState, type ReactNode } from 'react'
import type { ExportFormat } from 'extraction-result-export'
import {
  batchExtractionProgress,
  type BatchExtraction,
} from '../../shared/batchExtraction.contract'
import { Button, Pill } from '../ui'
import { memberStatus, type StatusTone } from './batchExtractionStatus'

const statusInk: Record<StatusTone, string> = {
  neutral: 'text-ink-muted',
  accent: 'text-accent',
  success: 'text-green',
  danger: 'text-danger',
}

/** The little state dot every status rendering leads with. */
function StatusDot() {
  return (
    <span
      aria-hidden="true"
      className="size-1.5 shrink-0 rounded-full bg-current"
    />
  )
}

/** Bare dot-plus-label status text (the pill-less rendering). */
function StatusLine({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span
      className={`flex items-center gap-1.5 text-[11px] font-semibold ${statusInk[tone]}`}
    >
      <StatusDot />
      {label}
    </span>
  )
}

function RerunIcon() {
  return (
    <svg
      aria-hidden="true"
      width="13"
      height="13"
      viewBox="0 0 20 20"
      fill="none"
    >
      <path
        d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6M16.5 3v3.5H13"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function DocumentIcon() {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      width="13"
      height="13"
      viewBox="0 0 20 20"
      fill="none"
    >
      <path
        d="M11.5 2.5H6.25A1.75 1.75 0 0 0 4.5 4.25v11.5a1.75 1.75 0 0 0 1.75 1.75h7.5a1.75 1.75 0 0 0 1.75-1.75V6.5l-4-4Zm0 0V6.5h4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function stamp(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/** Status chip shared by the summary line and every member row. */
export function StatusPill({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <Pill tone={tone} className="gap-1.5">
      <StatusDot />
      {label}
    </Pill>
  )
}

function batchStatus(batch: BatchExtraction): {
  label: string
  tone: StatusTone
  running: boolean
} {
  // Each member keeps its own lifecycle: a paused, failed or stopped member is counted as such, never as a result.
  const counts = new Map<string, number>()
  for (const member of batch.members)
    counts.set(member.executionStatus, (counts.get(member.executionStatus) ?? 0) + 1)
  const active = ['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING'].some((state) => counts.has(state))
  return {
    label: [...counts].map(([state, count]) => `${count} ${state.toLowerCase()}`).join(' · '),
    tone: counts.has('FAILED') ? 'danger' : active ? 'accent' : 'neutral',
    running: active,
  }
}

function batchSchemaLine(batch: BatchExtraction): string {
  return `${batch.extractionSchemaName} · Schema Revision ${batch.schemaRevisionNumber}`
}

function RetainedBatchExport({disabled,onExport}:{disabled:boolean;onExport:(format:ExportFormat)=>Promise<void>}) {
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null)
  const download=async(format:ExportFormat)=> {
    setBusy(true);setOpen(false);setError(null)
    try {await onExport(format)}
    catch(error){setError(error instanceof Error?error.message:'Unable to export saved values.')}
    finally {setBusy(false)}
  }
  return <div className="space-y-1">
    <Button disabled={disabled||busy} aria-expanded={open} aria-haspopup="menu" onClick={()=>setOpen(!open)}>{busy?'Exporting…':'Export'}</Button>
    {open&&<div role="menu" aria-label="Retained batch exports" className="flex flex-wrap gap-2">
      <Button role="menuitem" onClick={()=>void download('csv')}>Export CSV bundle</Button>
      <Button role="menuitem" onClick={()=>void download('xlsx')}>Export XLSX</Button>
    </div>}
    {error&&<p role="alert" className="text-secondary text-danger">{error}</p>}
  </div>
}

function selectionLine(batch: BatchExtraction): string {
  const count = batch.members.length
  const strategy = batch.strategy === 'CATALOG' ? 'Catalog' : 'Article'
  return `${count} Source Document${count === 1 ? '' : 's'} · ${strategy}`
}

/** The "Pilot" label's own threshold — smaller than the gate's
 *  `PILOT_BATCH_SELECTION_LIMIT` (which just caps how large a run may be
 *  without a stabilised schema). This only decides what a run is *called*
 *  in the history list, matching the 2-3 documents the pilot banner and
 *  "Pilot Extraction" button actually recommend. */
const PILOT_LABEL_LIMIT = 3

function isPilotRound(batch: BatchExtraction): boolean {
  return batch.members.length <= PILOT_LABEL_LIMIT
}

export function BatchExtractionHistory({
  batches,
  onOpen,
}: {
  batches: readonly BatchExtraction[]
  onOpen(batch: BatchExtraction): void
}) {
  if (batches.length === 0)
    return (
      <p className="py-6 text-center text-xs text-ink-muted">
        No Batch Extractions yet. Start with "New Batch Extraction" above —
        pick just 2-3 Source Documents for a first pilot run before
        committing to the whole collection.
      </p>
    )
  return (
    <ul className="divide-y divide-line" aria-live="polite">
      {batches.map((batch) => {
        const status = batchStatus(batch)
        const progress = batchExtractionProgress(batch)
        const completed = progress.extracted
        const percent = progress.total > 0 ? (completed / progress.total) * 100 : 0
        return (
          <li key={batch.batchExtractionId}>
            {/* `-mx-2 px-2` keeps the hover fill wider than the text while the
                text itself stays flush with the panel heading. */}
            <button
              className="-mx-2 grid w-[calc(100%+1rem)] grid-cols-1 items-center gap-2 rounded-xs px-2 py-3.5 text-left outline-none hover:bg-line/20 sm:grid-cols-[1fr_13rem_auto] sm:gap-6"
              type="button"
              onClick={() => onOpen(batch)}
            >
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <strong className="text-[12.5px] font-semibold text-ink">
                    <time dateTime={batch.createdAt}>{stamp(batch.createdAt)}</time>
                  </strong>
                  {isPilotRound(batch) && (
                    <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[9.5px] font-semibold text-accent">
                      Pilot
                    </span>
                  )}
                </span>
                <span className="mt-1 block text-[11px] text-ink-muted">
                  {batchSchemaLine(batch)}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-faint">
                  <DocumentIcon />
                  {selectionLine(batch)}
                </span>
              </span>
              {status.running ? (
                <span className="w-full">
                  <StatusLine tone={status.tone} label={status.label} />
                  {/* Same square-ended hard-stop track as PhaseProgress. */}
                  <span
                    aria-hidden="true"
                    className="mt-1.5 block h-0.5 w-full"
                    style={{
                      background: `linear-gradient(to right, var(--color-accent) ${percent}%, var(--color-line) ${percent}%)`,
                    }}
                  />
                </span>
              ) : (
                <span className="justify-self-start">
                  <StatusPill tone={status.tone} label={status.label} />
                </span>
              )}
              <span
                className="hidden shrink-0 text-[15px] font-bold leading-none text-ink-muted sm:block"
                aria-hidden="true"
              >
                ›
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function BatchExtractionMembers({
  batch,
  pinnedSchemaFailure,
  hasSuccessfulResult,
  coverageMessage,
  opening,
  canRunAgain,
  runAgainRefusal,
  runAgainMethod,
  documentName,
  onExport,
  onRetrySchema,
  onRunAgain,
  onOpenMember,
}: {
  batch: BatchExtraction
  pinnedSchemaFailure: string | null
  hasSuccessfulResult: boolean
  coverageMessage: string | null
  opening: boolean
  /** Run again submits the account's saved method, so it waits until that has been read. */
  canRunAgain: boolean
  /** Why this batch's Schema Revision cannot run again (no longer current, or its scope is not the batch's strategy). */
  runAgainRefusal: string | null
  /** The saved method Run again submits, with its loading, error and stale-settings refusal. */
  runAgainMethod: ReactNode
  documentName(sourceDocumentId: string): string
  onExport(format: ExportFormat): Promise<void>
  onRetrySchema(): void
  onRunAgain(): void
  onOpenMember(sourceDocumentId: string, extractionId: string): void
}) {
  const status = batchStatus(batch)
  const runAgainRefusalId = useId()
  return (
    <>
      <div className="mb-5 flex flex-col gap-3 rounded-card border border-line bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-[11px] text-ink-faint">
          {batchSchemaLine(batch)} · {selectionLine(batch)}
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <StatusLine tone={status.tone} label={status.label} />
          <RetainedBatchExport disabled={!hasSuccessfulResult} onExport={onExport}/>
          <Button
            size="sm"
            variant="secondary"
            disabled={opening || !canRunAgain || runAgainRefusal !== null}
            aria-describedby={runAgainRefusal ? runAgainRefusalId : undefined}
            onClick={onRunAgain}
          >
            <RerunIcon />
            {opening ? 'Running again…' : 'Run again'}
          </Button>
        </div>
      </div>
      {runAgainRefusal && (
        <p id={runAgainRefusalId} className="mb-4 text-[11.5px] leading-snug text-ink-muted">
          {runAgainRefusal}
        </p>
      )}
      <div className="mb-4">{runAgainMethod}</div>
      {pinnedSchemaFailure && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <p className="text-[11.5px] leading-snug text-danger" role="alert">
            {pinnedSchemaFailure}
          </p>
          <Button size="sm" variant="secondary" onClick={onRetrySchema}>
            Retry Schema Revision
          </Button>
        </div>
      )}
      {coverageMessage && (
        <p
          className="mb-4 text-[11.5px] leading-snug text-ink-muted"
          role="status"
        >
          {coverageMessage}
        </p>
      )}
      <div
        aria-hidden="true"
        className="grid grid-cols-[1fr_auto] items-center gap-6 border-b border-line pb-2 text-[11px] font-semibold text-ink-muted sm:grid-cols-[1fr_13rem_auto]"
      >
        <span>Documents</span>
        <span className="hidden sm:block">Status</span>
        <span className="hidden w-3 sm:block" />
      </div>
      <ul className="divide-y divide-line" aria-label="Batch Extraction members">
        {batch.members.map((member) => {
          const memberState = memberStatus(member)
          return (
            <li key={member.sourceDocumentId}>
              {/* `-mx-2 px-2`: hover fill wider than the text, text still flush
                  with the column headings above. */}
              <button
                className="-mx-2 grid w-[calc(100%+1rem)] grid-cols-[1fr_auto] items-center gap-6 rounded-xs px-2 py-3.5 text-left outline-none hover:bg-line/20 disabled:cursor-default disabled:hover:bg-transparent sm:grid-cols-[1fr_13rem_auto]"
                type="button"
                onClick={() => onOpenMember(member.sourceDocumentId, member.extractionId)}
              >
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-2 text-ink-faint">
                    <DocumentIcon />
                    <span className="min-w-0 truncate text-[12.5px] font-semibold text-ink">
                      {documentName(member.sourceDocumentId)}
                    </span>
                  </span>
                  {memberState.message && (
                    <span
                      className={`mt-1 block pl-[21px] text-[11px] leading-snug ${statusInk[memberState.tone]}`}
                    >
                      {memberState.message}
                    </span>
                  )}
                </span>
                <span className="justify-self-start">
                  <StatusPill
                    tone={memberState.tone}
                    label={memberState.label}
                  />
                </span>
                <span
                  aria-hidden="true"
                  className="hidden shrink-0 text-[15px] font-bold leading-none text-ink-muted sm:block"
                >
                  ›
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
