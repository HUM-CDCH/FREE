import { useEffect, useState, type RefObject } from 'react'
import type { ExportChoices, ExportFormat } from 'extraction-result-export'
import type { SchemaNode } from 'extraction/schema'
import ExtractionResultExportControl from '../ExtractionResultExportControl'
import { getSchemaRevision, listExtractionSchemas } from '../schemaRevisions'
import { exportProjectResults } from './projectExport'

/**
 * The project's export (ADR 0041): every reviewed document's results on the Current Template Revision, in one file,
 * through the export's own options and format. The options project through that revision's fields, read once opened.
 */
export default function ProjectExportDialog({ projectContextId, currentSchemaRevisionId, documents, name, returnFocusRef, onDismiss }: {
  projectContextId: string
  currentSchemaRevisionId: string
  documents: readonly { id: string; name: string }[]
  /** The file's name: the project's. */
  name: string
  returnFocusRef?: RefObject<HTMLElement | null>
  onDismiss: () => void
}) {
  const [schemaNodes, setSchemaNodes] = useState<readonly SchemaNode[]>([])
  const [state, setState] = useState<{ status: 'idle' } | { status: 'exporting' } | { status: 'done'; message: string } | { status: 'failed'; message: string }>({ status: 'idle' })
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      const schemas = await listExtractionSchemas(projectContextId, undefined, controller.signal)
      const owner = schemas.find((schema) => schema.currentRevision?.schemaRevisionId === currentSchemaRevisionId)
      if (!owner) return
      const revision = await getSchemaRevision(projectContextId, owner.extractionSchemaId, currentSchemaRevisionId, controller.signal)
      if (!controller.signal.aborted) setSchemaNodes(revision.schemaNodes)
    })().catch(() => { /* the options fall back to one row per record */ })
    return () => controller.abort()
  }, [projectContextId, currentSchemaRevisionId])

  const run = async (format: ExportFormat, choices: ExportChoices) => {
    setState({ status: 'exporting' })
    try {
      const started = await exportProjectResults(projectContextId, { summary: { currentSchemaRevisionId }, documents }, name, format, choices)
      setState(started ? { status: 'done', message: 'Download started. Check your browser’s downloads.' }
        : { status: 'done', message: 'No document has reviewed results on the current template yet.' })
    } catch (error) {
      setState({ status: 'failed', message: `Could not export: ${error instanceof Error ? error.message : 'the results could not be read.'} Try again.` })
    }
  }

  return (
    <>
      <ExtractionResultExportControl open={state.status === 'idle'} schemaNodes={schemaNodes} returnFocusRef={returnFocusRef}
        onDismiss={onDismiss} onExport={(format, choices) => void run(format, choices)} />
      {state.status !== 'idle' && (
        <p role={state.status === 'failed' ? 'alert' : 'status'}
          className={`m-0 text-[11px] leading-snug [overflow-wrap:anywhere] ${state.status === 'failed' ? 'text-danger' : 'text-ink-muted'}`}>
          {state.status === 'exporting' ? 'Preparing the export of every reviewed document…' : state.message}
          {state.status !== 'exporting' && (
            <button type="button" className="ml-2 cursor-pointer text-ink-muted underline outline-none hover:text-ink" onClick={onDismiss}>Dismiss</button>
          )}
        </p>
      )}
    </>
  )
}
