import { useEffect, useState } from 'react'
import type { ValueHistory as History } from '../shared/documentHistory.contract'
import { readValueHistory } from './durableExtractionApi'
import { reviewedValueSummary } from './reviewVocabulary'
import Button from './ui/Button'

const at = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function decisionWord({ processing, decision, decisionIncompatible }: History['readings'][number]) {
  if (processing === 'absent') return 'Missing'
  if (processing !== 'saved') return 'Not read'
  if (decisionIncompatible) return 'Earlier decision no longer fits'
  return decision?.action === 'APPROVED' ? 'Approved' : decision?.action === 'EDITED' ? 'Edited' : decision?.action === 'REJECTED' ? 'Rejected' : 'To check'
}

/** One value's latest reading in each Extraction of the document that read the same Source Representation, newest first,
 *  with the decision review shows and the name it had there. Read while the History tab is shown. */
export default function ValueHistory({ projectContextId, sourceDocumentId, extractionId, valueId, name, visible, shownExtractionId, onOpen, onBack }: {
  projectContextId: string
  sourceDocumentId: string
  /** The Extraction whose value the history follows. */
  extractionId: string
  valueId: string
  name: string
  visible: boolean
  shownExtractionId: string | null
  onOpen: (extractionId: string) => void
  onBack: () => void
}) {
  const [history, setHistory] = useState<History | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    readValueHistory(projectContextId, sourceDocumentId, extractionId, valueId, controller.signal).then(
      (read) => { if (!controller.signal.aborted) { setHistory(read); setError(null) } },
      (cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'The value history could not be read.') },
    )
    return () => controller.abort()
  }, [visible, projectContextId, sourceDocumentId, extractionId, valueId])
  return (
    <section aria-label={`History of ${name}`} className="rounded-md border border-line bg-surface p-3 text-secondary">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="m-0 min-w-0 truncate text-secondary font-semibold" title={name}>History of {name}</h3>
        <button type="button" className="shrink-0 cursor-pointer text-compact text-accent underline" onClick={onBack}>Whole document</button>
      </div>
      <p className="m-0 text-compact text-ink-muted">Latest reading from each Extraction</p>
      {error && <p role="alert" className="text-danger">{error}</p>}
      {!history && !error && <p className="m-0 pt-2 text-ink-muted">Loading…</p>}
      {history && <div className="space-y-2 pt-2">
        <ol aria-label={`Readings of ${name}`} className="m-0 list-none space-y-2 p-0">
          {history.readings.map((reading) => {
            const shown = reading.extractionId === shownExtractionId
            const edited = reading.decision?.action === 'EDITED'
            const text = reviewedValueSummary(reading.node, edited ? reading.decision!.value : reading.modelValue)
            return (
              <li key={reading.extractionId} aria-current={shown || undefined} className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block break-words text-ink">{reading.decision?.action === 'REJECTED' ? <s>{text}</s> : text}</span>
                  {edited && <span className="block text-compact text-ink-muted">Extracted: <s>{reviewedValueSummary(reading.node, reading.modelValue)}</s></span>}
                  <span className="block text-compact text-ink-muted">
                    {[at(reading.createdAt), decisionWord(reading), `schema rev ${reading.schemaRevision.revisionNumber}`,
                      reading.node.name !== name && `named ${reading.node.name}`].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {shown ? <span className="shrink-0 text-compact font-semibold text-accent">Shown</span>
                  : <Button aria-label={`Open Extraction of ${at(reading.createdAt)}`} onClick={() => onOpen(reading.extractionId)}>Open</Button>}
              </li>
            )
          })}
        </ol>
        {history.unmatched > 0 && <p className="m-0 text-compact text-ink-muted">No matching value in {plural(history.unmatched, 'Extraction')}.</p>}
        {history.untraceableRevisions > 0 && <p className="m-0 text-compact text-ink-muted">Not traceable across {plural(history.untraceableRevisions, 'different source revision')}.</p>}
        {history.truncated && <p className="m-0 text-compact text-ink-muted">Searched only the newest Extractions of this document.</p>}
      </div>}
    </section>
  )
}
