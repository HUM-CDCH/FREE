import { useEffect, useState } from 'react'
import type { DocumentHistory as History } from '../shared/documentHistory.contract'
import { readDocumentHistory } from './durableExtractionApi'
import type { SavedReviewCut } from './durableReviewLinks'
import Button from './ui/Button'

const at = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const word = (value: string) => value[0] + value.slice(1).toLowerCase()
const revisions = (numbers: number[]) => numbers.length === 1 ? `schema rev ${numbers[0]}` : `schema revs ${numbers.join(', ')}`
const shownTag = <span className="shrink-0 text-compact font-semibold text-accent">Shown</span>

/** The document's Extractions, newest first: which one Results shows, which one the document opens on, and the schema
 *  revisions and finalized reviews of each. Read while the History tab is shown, and again when `refreshKey` changes. */
export default function DocumentHistory({ projectContextId, sourceDocumentId, visible, refreshKey, shown, currentSchemaRevision, onOpen }: {
  projectContextId: string
  sourceDocumentId: string
  visible: boolean
  refreshKey: string
  shown: { extractionId: string; cut: SavedReviewCut | null } | null
  currentSchemaRevision: { schemaRevisionId: string; revisionNumber: number } | null
  onOpen: (extractionId: string, cut?: SavedReviewCut) => void
}) {
  const [history, setHistory] = useState<History | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    readDocumentHistory(projectContextId, sourceDocumentId, controller.signal).then(
      (read) => { setHistory(read); setError(null) },
      (cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'The document history could not be read.') },
    )
    return () => controller.abort()
  }, [visible, projectContextId, sourceDocumentId, refreshKey])
  const latestId = history?.extractions.find((extraction) => extraction.currentSource)?.extractionId
  const currentUnused = history && currentSchemaRevision && history.extractions.length > 0 && !history.extractions.some((extraction) =>
    [...extraction.schemaRevisions, ...(extraction.pendingSchemaRevision ? [extraction.pendingSchemaRevision] : [])]
      .some((revision) => revision.schemaRevisionId === currentSchemaRevision.schemaRevisionId))
  return (
    <details open className="rounded-md border border-line bg-surface p-3">
      <summary className="cursor-pointer text-secondary font-semibold">This document</summary>
      {error && <p role="alert" className="text-secondary text-danger">{error}</p>}
      {!history && !error && <p className="m-0 pt-2 text-secondary text-ink-muted">Loading…</p>}
      {history && <div className="space-y-2 pt-2 text-secondary">
        {currentUnused && <p className="m-0 text-compact text-ink-muted">Not run yet with the current schema revision (rev {currentSchemaRevision.revisionNumber}, shared across the Project).</p>}
        <ol aria-label="Extractions of this document" className="m-0 list-none space-y-2 p-0">
          {history.extractions.map((extraction) => {
            const { extractionId } = extraction
            const isShown = shown?.extractionId === extractionId
            const tags = [extractionId === latestId && 'Latest', extraction.batchExtractionId && 'Batch',
              !extraction.currentSource && `Earlier source text (rev ${extraction.sourceRevisionNumber})`].filter(Boolean)
            const schema = extraction.schemaRevisions.length ? revisions(extraction.schemaRevisions.map((revision) => revision.revisionNumber)) : null
            return (
              <li key={extractionId} aria-current={isShown && !shown.cut || undefined} className="space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className={isShown ? 'font-semibold text-ink' : 'text-ink'}>{at(extraction.createdAt)}</span>
                    {tags.map((tag) => <span key={String(tag)} className="ml-1.5 rounded bg-surface-muted px-1 text-overline font-semibold text-ink-muted">{tag}</span>)}
                    <span className="block text-compact text-ink-muted">
                      {[word(extraction.status), word(extraction.strategy), schema,
                        extraction.pendingSchemaRevision && `rev ${extraction.pendingSchemaRevision.revisionNumber} pending`].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {isShown && !shown.cut ? shownTag
                    : <Button aria-label={`Open Extraction of ${at(extraction.createdAt)}`} onClick={() => onOpen(extractionId)}>Open</Button>}
                </div>
                {extraction.finalizations.map(({ snapshotVersion, feedbackVersion, createdAt }) => {
                  const reviewShown = isShown && shown.cut?.snapshotVersion === snapshotVersion && shown.cut.feedbackVersion === feedbackVersion
                  return (
                    <div key={`${snapshotVersion}:${feedbackVersion}`} aria-current={reviewShown || undefined}
                      className="flex items-center justify-between gap-2 ps-3 text-compact text-ink-muted">
                      <span className="min-w-0">Review finalized · {at(createdAt)} · results {snapshotVersion}</span>
                      {reviewShown ? shownTag
                        : <Button aria-label={`Open the review finalized ${at(createdAt)}`} onClick={() => onOpen(extractionId, { snapshotVersion, feedbackVersion })}>Open</Button>}
                    </div>
                  )
                })}
              </li>
            )
          })}
        </ol>
        {history.truncated && <p className="m-0 text-compact text-ink-muted">Showing the newest {history.extractions.length} Extractions.</p>}
      </div>}
    </details>
  )
}
