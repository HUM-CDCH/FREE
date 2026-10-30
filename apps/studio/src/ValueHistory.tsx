import { useEffect, useRef, useState } from 'react'
import type { ValueHistory as History } from '../shared/documentHistory.contract'
import { readValueHistory } from './durableExtractionApi'
import { reviewedValueSummary, shownValue } from './reviewVocabulary'
import Button from './ui/Button'

const at = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

type Reading = History['readings'][number]
/** Whether the decision gives the value review shows: an edit, or the readings chosen at a Value Disagreement. */
const reviewed = (reading: Reading) => reading.decision !== null && 'value' in reading.decision

/** The value as Results shows it: the reviewed one, the readings of an undecided disagreement, or the model's. */
function valueText(reading: Reading) {
  if (reviewed(reading)) return reviewedValueSummary(reading.node, reading.decision!.value)
  const root = reading.disagreement?.find((entry) => entry.path.length === 0)
  return root ? root.alternatives.map((alternative) => shownValue(alternative.value)).join(' or ') : reviewedValueSummary(reading.node, reading.modelValue)
}

function decisionWord(reading: Reading) {
  const { processing, decision, decisionIncompatible } = reading
  if (processing === 'absent') return 'Missing'
  if (processing !== 'saved') return 'Not read'
  if (decisionIncompatible) return 'Earlier decision no longer fits'
  if (reading.disagreement && !reviewed(reading) && (!decision || decision.action === 'PENDING')) return 'Readings differ'
  return decision?.action === 'APPROVED' ? 'Approved' : decision?.action === 'EDITED' ? 'Edited' : decision?.action === 'REJECTED' ? 'Rejected' : 'To check'
}

/** One value's latest reading in each Extraction of the document that read the same Source Representation, newest first,
 *  with the decision review shows and the name it had there. Read while the History tab is shown. */
export default function ValueHistory({ projectContextId, sourceDocumentId, extractionId, valueId, name, visible, refreshKey, shownExtractionId, onOpen, onBack }: {
  projectContextId: string
  sourceDocumentId: string
  /** The Extraction whose value the history follows. */
  extractionId: string
  valueId: string
  name: string
  visible: boolean
  /** Read again when it changes, e.g. when a run starts or ends. */
  refreshKey: string
  shownExtractionId: string | null
  onOpen: (extractionId: string) => void
  onBack: () => void
}) {
  const [history, setHistory] = useState<History | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Focus follows the researcher: to the heading when the history opens, to a row whose Open became "Shown".
  const headingRef = useRef<HTMLHeadingElement>(null), rows = useRef(new Map<string, HTMLLIElement>()), opened = useRef<string | null>(null)
  useEffect(() => { headingRef.current?.focus() }, [])
  useEffect(() => {
    if (opened.current === null || opened.current !== shownExtractionId) return
    rows.current.get(opened.current)?.focus()
    opened.current = null
  }, [shownExtractionId, history])
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    readValueHistory(projectContextId, sourceDocumentId, extractionId, valueId, controller.signal).then(
      (read) => { if (!controller.signal.aborted) { setHistory(read); setError(null) } },
      (cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'The value history could not be read.') },
    )
    return () => controller.abort()
  }, [visible, projectContextId, sourceDocumentId, extractionId, valueId, refreshKey])
  return (
    <section aria-label={`History of ${name}`} className="rounded-md border border-line bg-surface p-3 text-secondary">
      <div className="flex items-baseline justify-between gap-2">
        <h3 ref={headingRef} tabIndex={-1} className="m-0 min-w-0 truncate text-secondary font-semibold outline-none" title={name}>History of {name}</h3>
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
            const text = valueText(reading)
            return (
              <li key={reading.extractionId} aria-current={shown || undefined} tabIndex={-1} className="flex items-start justify-between gap-2 outline-none"
                ref={(row) => { if (row) rows.current.set(reading.extractionId, row); else rows.current.delete(reading.extractionId) }}>
                <span className="min-w-0">
                  <span className="block break-words text-ink">{reading.decision?.action === 'REJECTED' ? <s>{text}</s> : text}</span>
                  {edited && <span className="block text-compact text-ink-muted">Extracted: <s>{reviewedValueSummary(reading.node, reading.modelValue)}</s></span>}
                  <span className="block text-compact text-ink-muted">
                    {[at(reading.createdAt), decisionWord(reading), `schema rev ${reading.schemaRevision.revisionNumber}`,
                      reading.node.name !== name && `named ${reading.node.name}`].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {shown ? <span className="shrink-0 text-compact font-semibold text-accent">Shown</span>
                  : <Button aria-label={`Open Extraction of ${at(reading.createdAt)}`} onClick={() => { opened.current = reading.extractionId; onOpen(reading.extractionId) }}>Open</Button>}
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
