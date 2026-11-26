import { useRef, useState } from 'react'
import { Button, phaseLabels } from '../ui'
import { guidedWorkflow } from './guidedWorkflow'
import ProjectExportDialog from './ProjectExportDialog'
import type { ProjectContext } from './transport'

/** The batch's work on this page (ADR 0041): extracting the documents left, reviewing them in the grid, exporting. */
export type ProjectBatchActions = {
  extract: () => void
  review: () => void
  upload: () => void
  /** What the project's export reads: its documents, and the name its file takes. */
  exported: { projectContextId: string; documents: readonly { id: string; name: string }[]; name: string }
}

/**
 * Where the project stands. Until the template is approved the chat leads the workflow (pilot, approval), so this page
 * offers only the way into the chat on a document; uploading happens here, so that step points to the documents
 * below. Once it is approved the batch is this page's (ADR 0041): extracting the documents left, reviewing them in the
 * grid and exporting start here, and the chat points here.
 */
export default function ProjectStatus({
  summary,
  sourcesInFlight = false,
  onContinue,
  batch = null,
}: {
  summary: ProjectContext['summary']
  /** Source Ingestions this project still has queued or parsing. */
  sourcesInFlight?: boolean
  /** Opens a document, where the chat goes on; null while the project has none. */
  onContinue: (() => void) | null
  batch?: ProjectBatchActions | null
}) {
  const workflow = guidedWorkflow(summary, { sourcesInFlight })
  const next = workflow.next
  // The approved template's batch: its steps, or a finished project, are this page's.
  const here = batch !== null && summary.schemaStabilised && summary.currentSchemaRevisionId !== null
    && (!next || next.step === 'batch' || next.step === 'review')
  const state = workflow.waiting
    ?? (!next
      ? 'Every document is extracted and reviewed.'
      : next.step === 'upload'
        ? 'Next: upload documents below.'
        : here ? `Next: ${next.label}` : `Next in the chat: ${next.label}`)
  const [exporting, setExporting] = useState(false)
  const exportButton = useRef<HTMLButtonElement>(null)
  const lead = !here || workflow.waiting ? null : !next ? 'export' : next.step === 'batch' ? 'extract' : 'review'
  return (
    <section aria-label="Project status"
      className="mb-5 flex flex-col gap-3 rounded-card border border-line bg-surface px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 text-overline font-bold uppercase tracking-[0.12em] text-ink-muted">{phaseLabels[summary.phase]}</p>
          <p className="m-0 text-xs font-semibold text-ink">{state}</p>
        </div>
        {!here && onContinue && (
          <Button variant="positive" size="md" onClick={onContinue}>
            Continue in chat<span aria-hidden="true"> →</span>
          </Button>
        )}
      </div>
      {here && batch && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Batch extraction">
          {next?.step === 'batch' && (
            <Button variant={lead === 'extract' ? 'positive' : 'secondary'} size="md" disabled={!!workflow.waiting} onClick={batch.extract}>
              {next.label}
            </Button>
          )}
          {(next?.step === 'review' || summary.reviewedSourceDocumentCount < summary.extractedSourceDocumentCount) && (
            <Button variant={lead === 'review' ? 'positive' : 'secondary'} size="md" onClick={batch.review}>Review in grid</Button>
          )}
          <Button ref={exportButton} variant={lead === 'export' ? 'positive' : 'secondary'} size="md"
            disabled={summary.reviewedSourceDocumentCount === 0} onClick={() => setExporting(true)}
            title={summary.reviewedSourceDocumentCount === 0 ? 'Export once a document is reviewed' : 'Every reviewed document, in one file'}>
            Export results…
          </Button>
          <Button variant="secondary" size="md" onClick={batch.upload}>Upload more documents</Button>
          {onContinue && (
            <button type="button" onClick={onContinue}
              className="ml-auto cursor-pointer text-xs font-semibold text-ink-muted outline-none hover:text-ink"
              title="Change the template in the chat; a changed template is approved again before the batch goes on">
              Change the template in the chat<span aria-hidden="true"> →</span>
            </button>
          )}
        </div>
      )}
      {exporting && batch && summary.currentSchemaRevisionId && (
        <ProjectExportDialog projectContextId={batch.exported.projectContextId} currentSchemaRevisionId={summary.currentSchemaRevisionId}
          documents={batch.exported.documents} name={batch.exported.name} returnFocusRef={exportButton} onDismiss={() => setExporting(false)} />
      )}
    </section>
  )
}
