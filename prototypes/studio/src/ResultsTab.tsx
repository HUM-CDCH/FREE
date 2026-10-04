import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { exportExtractionResult, type ExtractionProvenance, type ProvenanceClaim } from 'extraction-result-export'
import type { ParsedDocument } from 'extraction/parsed-document'
import type { SchemaDefinition } from 'extraction/schema'
import ExtractionResultExportControl from './ExtractionResultExportControl'
import { Button, ModalDialog, Toast } from './ui'
import { isRecord } from '../shared/template'
import { extractionStateFromAttempt, type ExtractionController } from './useExtraction'
import type { ExtractionAttempt, ReviewDecisionAction, ReviewDecisionInput } from '../shared/extraction.contract'
import { REVIEW_DRAFT_CONFLICT } from './reviewDrafts'
import { claimStatuses, linkOrigin, type ClaimStatus } from './claimStates'
import { applyReviewDecisions, orderResultFields, resultPathKey, schemaNodeAtResultPath } from './reviewDecisions'
import { DECISION_WORD, shownValue, partialRailModel, settledRailModel, type RailRecord, type RailRow, type ValueFilter } from './reviewVocabulary'
import { breakdownState, statusLine } from './resultsHeaderCopy'
import { recordDecision, undoLast, type HistoryEntry } from './reviewHistory'
import { evidenceQuote } from './evidenceQuote'
import { useToast } from './useToast'
import ResultsHeader from './ResultsHeader'
import ReviewList from './ReviewList'
import ReviewRow from './ReviewRow'
import RunDetailsDrawer, { type DrawerSection } from './RunDetailsDrawer'
import ResultsMenu from './ResultsMenu'
import ReviewFocus, { type EndCard } from './ReviewFocus'
import { nextToCheck, previousInRecord, queuePosition, reviewQueue } from './reviewQueue'
import { keyAction } from './reviewKeys'
import type { EvidenceLink } from '../shared/groundedExtraction'

type PinnedSchema = SchemaDefinition & {
  revisionNumber?: number
  schemaRevisionId?: string
}

/** One way to run (decision 03): the tab strip's "▶ Run extraction". The Results tab starts no Extraction itself; its
 *  empty state points at that button, or says why it cannot start (`runUnavailableReason`). */
const RUN_POINTER = 'Press ▶ Run extraction above.'

type ResultsTabProps = {
  controller: ExtractionController
  /** Why the tab strip's Run cannot start now, in its own words (its title); null or absent when Run can start. */
  runUnavailableReason?: string | null
  schemaReady: boolean
  sourceDocumentName: string
  /** The pinned document: the quotes of the selected value's Evidence. */
  parsedDocument?: ParsedDocument | null
  onSelectEvidence?: (anchorId: string) => void
  onResultPathChange?: (path: string[] | null) => void
  /** Extraction Schema the displayed attempt ran with; also the used-schema preview. */
  pinnedSchema?: PinnedSchema | null
  /** Extraction Schema of the displayed Extraction Result; leads the export columns. */
  exportSchema?: SchemaDefinition | null
  /** Acknowledged Current Schema Revision; null before the first durable save. */
  currentSchemaRevision?: { schemaRevisionId: string; revisionNumber: number } | null
  inspectedAttempt?: ExtractionAttempt
  readOnly?: boolean
  onEditField?: (nodeId: string, path: (string | number)[]) => void
  /** Each Evidence anchor's first page (anchor id → page): the chips, the record headers and the export. */
  evidencePages?: ReadonlyMap<string, number>
  /** The workspace's own header controls (snapshot choice, "Open latest reviewed"), before ⓘ. */
  headerExtras?: ReactNode
  /** The one-by-one value's Evidence, which the document dims around (§7.3); null outside one-by-one. */
  onFocusEvidence?: (link: EvidenceLink | null) => void
}

/** The path prefix the document's overlays filter by: none, so every link paints (§7.2), whatever the result's shape.
 *  One array, so a parent's state settles. */
const ALL_RECORDS: string[] = []
const ALL_TOUCHED = () => true

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

function getAtPath(value: unknown, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>((current, step) =>
    Array.isArray(current) ? current[Number(step)] : isRecord(current) ? current[String(step)] : undefined, value)
}

/**
 * The Results tab (results review redesign §2–§3, §5–§6, §8): one header in every phase, the list of records and
 * values for a running and a settled Extraction alike, decisions with undo, and saving only on a researcher's act.
 */
function ResultsTab({ controller, runUnavailableReason = null, schemaReady, sourceDocumentName, parsedDocument = null,
  pinnedSchema = null, exportSchema = null, currentSchemaRevision = null, inspectedAttempt, readOnly = false, onSelectEvidence,
  evidencePages, onResultPathChange, onEditField, headerExtras, onFocusEvidence }: ResultsTabProps) {
  const attempt = inspectedAttempt ?? controller.attempt
  const article = attempt?.strategy === 'ARTICLE'
  const state = useMemo(() => inspectedAttempt ? extractionStateFromAttempt(inspectedAttempt) : controller.state,
    [controller.state, inspectedAttempt])
  const review = controller.review
  const reviewed = Boolean(attempt?.reviewedAt)
  const viewOnly = readOnly || Boolean(inspectedAttempt)
  const decisions = inspectedAttempt?.reviewDecisions ?? (reviewed ? attempt!.reviewDecisions : review.decisions)
  const isTouched = viewOnly || reviewed ? ALL_TOUCHED : review.isTouched
  const partial = state.status === 'running' ? state.partial : null
  const running = state.status === 'running'
  const schemaNodes = useMemo(() => pinnedSchema?.schemaNodes ?? [], [pinnedSchema])

  // The run's order and kei's labels, kept while this workspace stays open (§3.1): settlement moves nothing.
  const [kept, setKept] = useState<{ from: unknown; order: number[]; labels: ReadonlyMap<number, string> }>(
    { from: null, order: [], labels: new Map() })
  if (partial && kept.from !== partial) {
    const labels = new Map(kept.labels)
    for (const record of partial.records) if (record.label) labels.set(record.index, record.label)
    setKept({ from: partial, order: partial.records.map((record) => record.index), labels })
  }
  const sawRun = kept.order.length > 0
  const statuses = useMemo(() => attempt ? claimStatuses(attempt) : new Map<string, ClaimStatus>(), [attempt])
  const claims = attempt?.diagnostics?.grounding?.claims ?? null
  const model = useMemo(() => partial
    ? partialRailModel(partial, { schemaNodes, decisions, isTouched, evidencePages, changed: review.changedAfterReview })
    : state.status === 'ready'
      ? settledRailModel(state.result, {
          schemaNodes, decisions, isTouched, evidencePages, changed: review.changedAfterReview, links: state.evidenceLinks,
          statuses: claims ? statuses : null, contested: attempt?.diagnostics?.contested ?? [],
          order: kept.order, labels: kept.labels,
        })
      : null,
  [partial, state, schemaNodes, decisions, isTouched, evidencePages, review.changedAfterReview, claims, statuses, attempt, kept])
  const counts = model?.counts ?? { toCheck: 0, doubtful: 0, notReviewable: 0, required: 0, approved: 0, edited: 0, rejected: 0 }
  const rows = useMemo(() => model ? [...model.document, ...model.records.flatMap((record) => record.rows)] : [], [model])
  const rowByKey = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows])

  const [filter, setFilter] = useState<ValueFilter>('all')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [toggles, setToggles] = useState<ReadonlyMap<number, boolean>>(new Map())
  // Read by the toast's Undo and by Z long after the render that made them: a ref, never a stale closure.
  const historyRef = useRef<HistoryEntry[]>([])
  const [announce, setAnnounce] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [drawer, setDrawer] = useState<DrawerSection | 'open' | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [codeView, setCodeView] = useState(false)
  // One by one (§4): the current value, and the record whose queue ran out (its end card's name).
  const [oneByOne, setOneByOne] = useState(false)
  const [currentKey, setCurrentKey] = useState<string | null>(null)
  // End cards have no current item; leaving still returns to the last value visited.
  const lastCurrentKey = useRef<string | null>(null)
  const [lastRecord, setLastRecord] = useState<number | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const headingFocus = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const listScroll = useRef<number | null>(null)
  const { toast, showToast, dismissToast, holdToast } = useToast()
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  // The row a decision, an undo or a cancelled edit returns focus to, after the render that shows it (§10).
  const focusRef = useRef<string | null>(null)
  const setFocusKey = (key: string) => { focusRef.current = key }
  const detailsRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (headingFocus.current) { headingFocus.current = false; headingRef.current?.focus() }
    if (!oneByOne && listScroll.current !== null && scrollRef.current) { scrollRef.current.scrollTop = listScroll.current; listScroll.current = null }
    if (focusRef.current === null) return
    rowRefs.current.get(focusRef.current)?.focus()
    focusRef.current = null
  })
  // Every link paints while the Results tab is open (§7.2): the list shows every record at once.
  const hasModel = model !== null
  useEffect(() => onResultPathChange?.(hasModel ? ALL_RECORDS : null), [hasModel, onResultPathChange])

  // A reopened document opens the first record with a value to check; a run opens records as they are read (§3.1).
  const [firstOpen, setFirstOpen] = useState<number | null | undefined>(undefined)
  if (firstOpen === undefined && model && !partial && !sawRun)
    setFirstOpen(model.records.find((record) => record.toCheck > 0)?.index ?? null)
  const isOpen = (record: RailRecord) => toggles.get(record.index) ??
    (sawRun ? record.state !== 'queued' : record.index === firstOpen || model?.records.length === 1)

  // The live region and the rail's notices for the run: discovery, records read, settlement, a stopped run (§5.2, §5.3).
  const seen = useRef({ discovered: 0, finished: new Set<number>() })
  // On one-by-one's caught-up card every record read joins the queue, and says so (§4.5).
  const caughtUpRef = useRef(false)
  useEffect(() => {
    if (!partial) return
    const was = seen.current
    if (was.discovered === 0 && partial.discovered > 0 && partial.strategy === 'CATALOG')
      setAnnounce(`${plural(partial.discovered, 'record')} found.${partial.startedAtPage === null ? '' : ` Reading from page ${partial.startedAtPage}.`}`)
    was.discovered = partial.discovered
    const read = partial.records.filter((record) => record.state === 'finished' && !was.finished.has(record.index))
    for (const record of read) {
      const label = record.label ?? `Record ${record.index + 1}`
      setAnnounce(was.finished.size === 0 || caughtUpRef.current ? `${label} read: its values can be reviewed now.` : `${label} read.`)
      was.finished.add(record.index)
    }
  }, [partial])
  // The toast's action runs long after this render: it reaches the latest one-by-one state through refs.
  const oneByOneRef = useRef(false)
  const enterRef = useRef<(key: string | null) => void>(() => {})
  // Once per settlement the controller reports, after the settled review has loaded, with the settled counts.
  const settledShown = useRef<unknown>(null)
  useEffect(() => {
    const settlement = review.settlement
    if (!settlement || settledShown.current === settlement || state.status !== 'ready' || review.loading) return
    settledShown.current = settlement
    const { kept, changed } = settlement
    const message = counts.toCheck === 0 && kept > 0
      ? `Run finished · your ${plural(kept, 'decision')} kept · nothing left to check.`
      : `Run finished · ${kept > 0 ? `your ${plural(kept, 'decision')} kept · ` : ''}${counts.toCheck} to check.`
    const full = changed > 0 ? `${message} · ${changed} changed after you reviewed them` : message
    showToast(full, counts.toCheck > 0 && !oneByOneRef.current
      ? { durationMs: 8000, action: { label: 'Review one by one', onAction: () => enterRef.current(null) } } : undefined)
    setAnnounce(full)
  }, [state.status, review.loading, review.settlement, counts.toCheck, showToast])
  useEffect(() => {
    if (review.discarded) showToast(`Run stopped · your ${plural(review.discarded, 'decision')} on it are discarded`)
  }, [review.discarded, showToast])
  useEffect(() => { if (review.draftRefused) showToast(review.draftRefused) }, [review.draftRefused, showToast])

  const canDecide = !viewOnly && !reviewed && !review.saving && (review.available || review.draftAvailable)
  const last = !running && counts.toCheck === 1 && canDecide && review.available
  const nodeOf = (row: RailRow) => schemaNodeAtResultPath(schemaNodes, row.resultPath)
  const queue = useMemo(() => model ? reviewQueue(model) : [], [model])
  const currentItem = oneByOne ? queue.find((item) => item.key === currentKey) ?? null : null
  const readableRecords = model?.records.some((record) => record.state === 'finished') ?? false
  useEffect(() => { caughtUpRef.current = oneByOne && !currentItem })
  // The document follows the current value (§4.3, §7.3); the dimming lasts as long as one-by-one.
  const currentLink = currentItem?.row.link ?? null
  // Once per current value: a re-render (a page the researcher scrolled to, a new callback) never pulls the PDF back.
  const followRef = useRef({ onFocusEvidence, onSelectEvidence, currentLink })
  useEffect(() => { followRef.current = { onFocusEvidence, onSelectEvidence, currentLink } })
  const followKey = oneByOne && currentLink ? `${currentItem?.key} ${currentLink.evidenceAnchorId}` : null
  useEffect(() => {
    const { onFocusEvidence, onSelectEvidence, currentLink } = followRef.current
    onFocusEvidence?.(followKey ? currentLink : null)
    if (followKey && currentLink) onSelectEvidence?.(currentLink.evidenceAnchorId)
  }, [followKey])
  useEffect(() => () => onFocusEvidence?.(null), [onFocusEvidence])

  const isOpenKey = (key: string | null) => key !== null && queue.find((item) => item.key === key)?.row.kind === 'to-check'
  function goTo(key: string | null) {
    setCurrentKey(key)
    if (key) lastCurrentKey.current = key
    setEditingKey(null)
    headingFocus.current = true
  }
  /** Enters one-by-one at the named value, else the selected one if it is to check, else the first in the queue (§4.1). */
  function enter(key: string | null = null) {
    if (!readableRecords || reviewed) return
    const start = isOpenKey(key) ? key : isOpenKey(selectedKey) ? selectedKey : nextToCheck(queue, null)
    listScroll.current = scrollRef.current?.scrollTop ?? 0
    setOneByOne(true)
    lastCurrentKey.current = null
    setLastRecord(null)
    setDrawer(null)
    setMenuOpen(false)
    setConfirming(false)
    goTo(start)
    setAnnounce(`One by one. ${counts.toCheck} to check.`)
  }
  /** Back to the list: the value that was current is selected and focused, the list where it was (§4.1). */
  function leave() {
    const key = currentKey ?? lastCurrentKey.current
    setOneByOne(false)
    setEditingKey(null)
    if (key) {
      const record = model?.records.find((record) => record.rows.some((row) => row.key === key))
      if (record) setToggles((current) => new Map(current).set(record.index, true))
      setSelectedKey(key)
      setFocusKey(key)
    }
    if (listScroll.current === null) listScroll.current = 0
  }
  useEffect(() => { oneByOneRef.current = oneByOne; enterRef.current = enter })

  async function save(message: string) {
    if (await review.accept()) { showToast(message); setAnnounce(message) }
  }

  function decide(row: RailRow, action: ReviewDecisionAction, value: ReviewDecisionInput['reviewedValue'] = null) {
    if (!row.decision) return
    historyRef.current = recordDecision(historyRef.current, row.decision, row.kind !== 'to-check')
    const next = oneByOne ? nextToCheck(queue, row.key) : null
    const { last: saves } = review.setDecision(row.resultPath, action, value)
    setEditingKey(null)
    if (oneByOne) {
      goTo(saves ? null : next)
      if (!next) setLastRecord(queue.find((item) => item.key === row.key)?.record ?? null)
    } else setFocusKey(row.key)
    const word = DECISION_WORD[action]
    if (saves) { void save(`${word} ${row.name}. Review saved; it is now read-only.`); return }
    showToast(`${word} ${row.name}.`, { durationMs: 8000, action: { label: 'Undo ⌨Z', onAction: undo } })
    const left = counts.toCheck - (row.kind === 'to-check' ? 1 : 0)
    const nextRow = next ? rowByKey.get(next) : null
    setAnnounce(`${word} ${row.name}.${running ? '' : ` ${left} to check.`}${nextRow ? ` Next: ${nextRow.name}, ${shownValue(nextRow.value)}.` : ''}`)
  }

  function undo() {
    if (reviewed || review.saving) return
    const undone = undoLast(historyRef.current, review.setDecision)
    if (!undone) return
    historyRef.current = undone.history
    const key = resultPathKey(undone.entry.resultPath)
    if (oneByOne) goTo(key)
    else { setSelectedKey(key); setFocusKey(key) }
    dismissToast()
    setAnnounce(`Undone. ${rowByKey.get(key)?.name ?? 'The value'} is to check again.`)
  }

  function undoOne(row: RailRow) {
    if (!row.decision) return
    historyRef.current = recordDecision(historyRef.current, row.decision, true)
    review.setDecision(row.resultPath, 'APPROVED', null, null, false)
    if (oneByOne) headingFocus.current = true
    else setFocusKey(row.key)
    setAnnounce(`${row.name} is to check again.`)
  }

  function select(row: RailRow) {
    const next = selectedKey === row.key ? null : row.key
    setSelectedKey(next)
    setEditingKey(null)
    if (next && row.link) onSelectEvidence?.(row.link.evidenceAnchorId)
  }

  function openDrawer(section: DrawerSection) {
    setMenuOpen(false)
    setDrawer(section ?? 'open')
  }

  /** The keyboard model (§4.4); keys act only while focus is within the rail. Enter is the editor's own. */
  function onKeyDown(event: React.KeyboardEvent) {
    const current = currentItem?.row
    const action = keyAction(event, {
      readable: readableRecords, saving: review.saving, editing: editingKey !== null, dialog: confirming, drawer: drawer !== null,
      menu: menuOpen, oneByOne, canUndo: historyRef.current.length > 0 && !reviewed && canDecide,
      current: !current ? null : current.kind === 'to-check' ? 'open' : 'decided',
    })
    if (!action || action === 'save-edit') return
    event.preventDefault()
    if (action === 'cancel-edit') { const key = editingKey; setEditingKey(null); if (oneByOne) headingFocus.current = true; else if (key) setFocusKey(key) }
    else if (action === 'close-dialog') setConfirming(false)
    else if (action === 'close-drawer') setDrawer(null)
    else if (action === 'close-menu') { setMenuOpen(false); menuRef.current?.focus() }
    else if (action === 'leave') leave()
    else if (action === 'undo') undo()
    else if (!current || !canDecide) return
    else if (action === 'approve') decide(current, 'APPROVED')
    else if (action === 'reject') decide(current, 'REJECTED')
    else if (action === 'edit') setEditingKey(current.key)
    else if (action === 'next') goTo(nextToCheck(queue, current.key) ?? current.key)
    else if (action === 'previous') goTo(previousInRecord(queue, current.key))
  }

  // The export and Values as code read the reviewed result, ordered by the schema.
  const reviewedResult = useMemo(() => state.status === 'ready' ? applyReviewDecisions(state.result, decisions) : null, [state, decisions])
  const records = isRecord(reviewedResult) && Array.isArray(reviewedResult.records) ? reviewedResult.records : null
  const articlePathPrefix = records ? records.length === 1 ? 2 : 1 : 0
  const displayResult = useMemo(() => {
    const unordered = records?.length === 1 ? records[0] : records ?? reviewedResult
    return pinnedSchema ? orderResultFields(unordered, pinnedSchema.schemaNodes) : unordered
  }, [records, reviewedResult, pinnedSchema])
  const openContested = useMemo(() => (state.status === 'ready' ? attempt?.diagnostics?.contested ?? [] : []).flatMap(({ resultPath, candidates }) => {
    const value = getAtPath(reviewedResult, resultPath)
    const rejected = decisions.find((decision) => resultPathKey(decision.resultPath) === resultPathKey(resultPath))?.action === 'REJECTED'
    return (value === null || value === undefined || value === '') && !rejected ? [{ path: resultPath.map(String).slice(articlePathPrefix), candidates }] : []
  }), [state.status, attempt, reviewedResult, decisions, articlePathPrefix])
  const linkCounts = useMemo(() => {
    const links = state.status === 'ready' ? state.evidenceLinks : partial?.records.flatMap((record) => record.evidenceLinks) ?? []
    const verifier = links.filter((link) => linkOrigin(link) === 'verifier').length
    return { verifier, rule: links.length - verifier }
  }, [state, partial])
  const madeDecisions = reviewed || viewOnly ? decisions : decisions.filter((decision) => review.isTouched(decision.resultPath))

  async function exportResult(format: Parameters<React.ComponentProps<typeof ExtractionResultExportControl>['onExport']>[0],
    choices: Parameters<React.ComponentProps<typeof ExtractionResultExportControl>['onExport']>[1]) {
    if (displayResult === null || exportSchema === null || state.status !== 'ready') return
    const madeByPath = new Map(madeDecisions.map((decision) => [resultPathKey(decision.resultPath), decision]))
    const linkByPath = new Map(state.evidenceLinks.map((link) => [resultPathKey(link.resultPath), link]))
    const provenance: ExtractionProvenance | undefined = attempt && claims ? {
      identity: [
        ['Extraction ID', attempt.extractionId], ['Strategy', attempt.strategy], ['Source Document', sourceDocumentName],
        ['Source Document ID', attempt.sourceDocumentId], ['Source Representation Revision ID', attempt.sourceRepresentationRevisionId],
        ['Schema Revision ID', attempt.schemaRevisionId], ['Reviewed at', attempt.reviewedAt ?? 'Not finalized'],
        ['Decisions', madeDecisions.length],
        ['Versions', Object.entries(attempt.diagnostics?.effectiveMethod?.versions ?? {}).map(([name, version]) => `${name} ${version}`).join(' · ') || 'Not recorded'],
        ['Field model', attempt.diagnostics?.models?.fields ?? 'Not recorded'], ['Reasoning model', attempt.diagnostics?.models?.reasoning ?? 'Not recorded'],
        ['Extraction complete', attempt.complete ? 'Yes (record recall unmeasured)' : 'Not shown complete: record recall unmeasured'],
        ['Claims', claims.claims], ['Verifier-supported', linkCounts.verifier],
        ...(linkCounts.rule > 0 ? [['Linked by rule', linkCounts.rule] as const] : []), ['Unsupported', claims.unsupported],
        ['Not completed', claims.notCompleted], ['Excluded by policy', claims.excluded],
        ['Document-level fields (not verified)', exportSchema.schemaNodes.filter((node) => node.valueSource === 'document').map((node) => node.name).join(', ') || 'None'],
        ['Exported at', new Date().toISOString()],
      ],
      claims: [...statuses].map(([key, status]): ProvenanceClaim => {
        const resultPath = JSON.parse(key) as (string | number)[]
        const link = linkByPath.get(key)
        const decision = madeByPath.get(key)
        return {
          ...(records && records.length > 1 ? { record: Number(resultPath[1]) } : {}),
          path: records ? resultPath.slice(2) : resultPath, extracted: getAtPath(state.result, resultPath),
          ...(decision ? { decision: decision.action, reviewed: decision.reviewedValue } : {}),
          outcome: status.state, ...(status.linkedBy ? { linkedBy: status.linkedBy } : {}), reasons: status.state === 'excluded' ? [status.policy ?? 'unverified'] : status.reasons,
          ...(link ? { anchorId: link.evidenceAnchorId, page: evidencePages?.get(link.evidenceAnchorId), precision: link.precision, verbatim: link.verbatim, lexicalHits: link.lexicalHits } : {}),
        }
      }),
    } : undefined
    await exportExtractionResult(displayResult, {
      format, filename: sourceDocumentName, schemaNodes: exportSchema.schemaNodes, choices,
      ...(openContested.length > 0 ? { contested: openContested.map(({ path, candidates }) => {
        const steps = path.map((step) => /^\d+$/.test(step) ? Number(step) : step)
        return Array.isArray(displayResult) && typeof steps[0] === 'number' ? { record: steps[0], path: steps.slice(1), candidates } : { path: steps, candidates }
      }) } : {}),
      ...(provenance ? { provenance } : {}),
    })
  }

  if (state.status === 'idle') {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center px-6 text-center">
        <p className="m-0 text-content font-semibold text-ink">No results yet</p>
        <p className="mt-1.5 mb-0 max-w-[34ch] text-compact leading-snug text-ink-muted">
          {schemaReady ? 'Run extraction to apply the schema across the source document.' : 'Generate a schema in the Schema tab first, then run extraction.'}
        </p>
        {!readOnly && schemaReady && <p className="mt-1.5 mb-0 text-compact font-semibold text-ink">{runUnavailableReason ?? RUN_POINTER}</p>}
      </div>
    )
  }

  const status = statusLine({
    state, attempt, partial, cancellationRequested: controller.cancellationRequested,
    schemaRevision: pinnedSchema?.revisionNumber ?? null, recordCount: model?.records.length ?? 0, decisionCount: decisions.length,
  })!
  const previousSchema = attempt && currentSchemaRevision && pinnedSchema?.revisionNumber !== undefined &&
    attempt.schemaRevisionId !== currentSchemaRevision.schemaRevisionId
    ? { revision: pinnedSchema.revisionNumber, current: currentSchemaRevision.revisionNumber } : null
  const editOpen = editingKey !== null
  const conflict = review.draftError === REVIEW_DRAFT_CONFLICT
  const breakdown = breakdownState({ running, saving: review.saving, saved: reviewed, error: review.error, loading: review.loading && !viewOnly,
    loaded: review.decisions.length > 0,
    draftSaving: review.draftSaving, draftSaved: review.draftSaved, draftError: review.draftError, conflict })
  const breakdownAction = breakdown.action === 'retry-draft' || breakdown.action === 'reload'
    ? <> · <button type="button" className="cursor-pointer text-accent underline" onClick={review.retryDraft}>{breakdown.action === 'reload' ? 'Reload server review' : 'Retry draft'}</button></>
    : breakdown.action === 'reload-review'
      ? <> · <button type="button" className="cursor-pointer text-accent underline" onClick={review.reload}>Reload</button></>
    : breakdown.action === 'retry'
      ? <> · <button type="button" className="cursor-pointer text-accent underline" onClick={() => void save('Review saved. It is now read-only.')}>Retry</button></>
      : null
  const toCheckRecords = model?.records.filter((record) => record.toCheck > 0) ?? []
  const doubtfulToCheck = rows.filter((row) => row.kind === 'to-check' && row.doubt !== null).length
  const scope = toCheckRecords.length === 1 && (model?.records.length ?? 0) > 1
    ? `${plural(counts.toCheck, 'value')} in ${toCheckRecords[0]!.label}${doubtfulToCheck ? `, including ${doubtfulToCheck} with a doubtful link` : ''}. The other ${(model?.records.length ?? 1) - 1 === 1 ? 'record is' : `${(model?.records.length ?? 1) - 1} records are`} already checked.`
    : `${plural(counts.toCheck, 'value')} across ${plural(toCheckRecords.length, 'record')}${doubtfulToCheck ? `, including ${doubtfulToCheck} with a doubtful link` : ''}.`
  const selectedRow = selectedKey ? rowByKey.get(selectedKey) ?? null : null
  const selectedNode = selectedRow ? nodeOf(selectedRow) : null
  // Up next: the next three values to check after the current one, in queue order (§4.3).
  const upNext = currentItem ? (() => {
    const at = queue.indexOf(currentItem)
    return [...queue.slice(at + 1), ...queue.slice(0, at)].filter((item) => item.row.kind === 'to-check').slice(0, 3)
  })() : []
  // The end cards (§4.5), when the queue has nothing current.
  const nextRecord = model?.records.find((record) => record.state === 'finished' && record.toCheck > 0) ?? null
  const stillReading = model?.records.filter((record) => record.state !== 'finished').length ?? 0
  const endLine = article
    ? running ? 'You’re caught up with what is read. Values join this queue as they become available.'
      : `${plural(counts.toCheck, 'value')} ${counts.toCheck === 1 ? 'is' : 'are'} left to check.`
    : running
    ? `You’re caught up with what is read. ${counts.toCheck > 0 ? `${plural(counts.toCheck, 'more value')} ${counts.toCheck === 1 ? 'is' : 'are'} read in other records; ` : ''}${plural(stillReading, 'record')} ${stillReading === 1 ? 'is' : 'are'} still being read, and their values join this queue as each one finishes.`
    : `${plural(counts.toCheck, 'value')} ${counts.toCheck === 1 ? 'is' : 'are'} left to check in ${plural((model?.records ?? []).filter((record) => record.toCheck > 0).length, 'more record')}.`
  const end: EndCard | null = !oneByOne || currentItem ? null
    : reviewed ? { kind: 'saved', line: `${counts.approved} approved, ${counts.edited} edited, ${counts.rejected} rejected. The review is now read-only. Values that aren’t part of the review stay as extracted.` }
      : lastRecord !== null
        ? { kind: 'record', label: model?.records.find((record) => record.index === lastRecord)?.label ?? `Record ${lastRecord + 1}`, line: endLine, next: nextRecord && { index: nextRecord.index } }
        : { kind: 'caught-up', line: running ? endLine : '', next: nextRecord && { index: nextRecord.index } }
  const saveAvailable = !viewOnly && !reviewed && counts.toCheck === 0 && review.canAccept
  const exportControl = (
    <ExtractionResultExportControl schema={exportSchema} disabled={displayResult === null} contestedCount={openContested.length}
      evidenceSheets={attempt !== null && claims !== null && state.status === 'ready'} onExport={exportResult}
      {...(reviewed ? {} : { open: exportOpen, onOpenChange: setExportOpen, returnFocusRef: menuRef })} />
  )

  return (
    <div className="@container relative flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <ResultsHeader
        status={status} extras={headerExtras} schemaNote={previousSchema}
        alert={!viewOnly && (controller.monitorError || controller.cancellationError) ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-stale bg-stale-soft px-2.5 py-1.5 text-compact text-stale-ink">
            {controller.monitorError
              ? <><span>{controller.monitorError}</span><Button onClick={controller.reconnect}>Reconnect</Button></>
              : <span>Cancellation failed: {controller.cancellationError}</span>}
          </div>
        ) : null}
        counts={counts} running={running}
        readOnlyNote={reviewed || viewOnly ? (counts.notReviewable > 0 ? `Read-only. ${plural(counts.notReviewable, 'value')} without a link were not part of the review.` : null) : undefined}
        actions={{
          oneByOne: viewOnly || reviewed || oneByOne || !model ? null : {
            disabled: !readableRecords ? 'Available once a record is read' : counts.toCheck === 0 ? 'Nothing left to check here' : null,
          },
          approveRest: oneByOne || viewOnly || reviewed || (state.status !== 'ready' && !running) ? null : {
            disabled: running ? 'Available when the run finishes' : counts.toCheck === 0 || editOpen || !review.available ? '' : null,
            expanded: confirming,
          },
          saveReview: saveAvailable && !oneByOne,
          list: oneByOne,
        }}
        breakdown={<span role={breakdown.action ? 'alert' : undefined}>{counts.approved} approved · {counts.edited} edited · {counts.rejected} rejected{breakdown.text && ` · ${breakdown.text}`}{breakdownAction}</span>}
        chips={(model !== null || running) && !codeView && !oneByOne} filter={filter} onFilter={setFilter}
        detailsOpen={drawer !== null} menuOpen={menuOpen} detailsRef={detailsRef} menuRef={menuRef}
        exportButton={reviewed ? exportControl : null}
        onDetails={() => openDrawer(null)} onMenu={() => setMenuOpen((open) => !open)}
        onSchema={() => openDrawer('schema')} onWhy={() => openDrawer('extraction')} onShowDetails={() => openDrawer('extraction')}
        onOneByOne={() => enter(null)} onApproveRest={() => setConfirming(true)}
        onSaveReview={() => void save('Review saved. It is now read-only.')} onList={leave}
      />
      {/* Contain absolute accessibility labels inside the list so deep rows cannot scroll the workspace. */}
      <div ref={scrollRef} className={`scrollbar-subtle relative min-h-0 flex-1 overflow-y-auto pb-20 ${oneByOne ? 'flex flex-col bg-surface' : 'bg-canvas p-2'}`}>
        {oneByOne ? (
          <ReviewFocus article={article}
            items={currentItem ? queuePosition(queue, currentItem.key)?.items ?? [] : []}
            position={currentItem ? queuePosition(queue, currentItem.key) : null}
            current={currentItem?.row ?? null}
            recordLabel={model?.records.find((record) => record.index === currentItem?.record)?.label ?? ''}
            label={`Record ${(currentItem?.record ?? 0) + 1}`}
            quote={currentItem?.row.link && parsedDocument
              ? evidenceQuote(parsedDocument, currentItem.row.link.evidenceAnchorId, currentItem.row.link.grounding?.raw ?? null, currentItem.row.extracted) : null}
            last={!running && counts.toCheck === 1 && currentItem?.row.kind === 'to-check' && review.available}
            editing={currentItem !== null && editingKey === currentItem.key}
            node={currentItem ? nodeOf(currentItem.row) : null}
            upNext={upNext}
            end={end}
            headingRef={headingRef}
            onDecide={(action, value) => currentItem && decide(currentItem.row, action, value ?? null)}
            onEdit={() => currentItem && setEditingKey(currentItem.key)}
            onCancelEdit={() => { setEditingKey(null); headingFocus.current = true }}
            onUndo={() => currentItem && undoOne(currentItem.row)}
            onNext={() => currentItem && goTo(nextToCheck(queue, currentItem.key) ?? currentItem.key)}
            onPrevious={() => currentItem && goTo(previousInRecord(queue, currentItem.key))}
            onGo={goTo}
            onContinue={(index) => goTo(queue.find((item) => item.record === index && item.row.kind === 'to-check')?.key ?? null)}
            onBack={leave} />
        ) : codeView ? (
          <div>
            <button type="button" className="mb-2 cursor-pointer text-secondary font-semibold text-accent" onClick={() => setCodeView(false)}>Back to review</button>
            <pre className="scrollbar-subtle m-0 overflow-auto rounded-md border border-line bg-surface px-3 py-2 font-mono text-compact whitespace-pre text-ink">{JSON.stringify(displayResult, null, 2)}</pre>
          </div>
        ) : state.status === 'cancelled' || state.status === 'error' ? (
          <p className="m-0 py-6 text-center text-secondary text-ink-muted">{state.status === 'cancelled' ? 'Stopped · nothing to review' : `Failed · ${state.message}`}</p>
        ) : (
          <ReviewList model={model ?? { document: [], records: [], counts }} article={article}
            finding={running && (!partial || (partial.discovered === 0 && partial.records.length === 0))}
            filter={filter} selectedKey={selectedKey} isOpen={isOpen}
            onToggle={(record) => setToggles((current) => new Map(current).set(record.index, !isOpen(record)))}
            renderRow={(row, pinned) => {
              const selected = row.key === selectedKey
              const anchor = row.link?.evidenceAnchorId
              return (
                <ReviewRow row={row} selected={selected} pinned={pinned} onSelect={() => select(row)}
                  rowRef={(element) => { if (element) rowRefs.current.set(row.key, element); else rowRefs.current.delete(row.key) }}
                  quote={selected && anchor && parsedDocument ? evidenceQuote(parsedDocument, anchor, row.link?.grounding?.raw ?? null, row.extracted) : null}
                  canDecide={canDecide} saved={reviewed} last={last && row.kind === 'to-check'} editing={editingKey === row.key}
                  node={selected ? nodeOf(row) : null}
                  onDecide={(action, value) => decide(row, action, value ?? null)}
                  onEdit={() => setEditingKey(row.key)} onCancelEdit={() => { setEditingKey(null); setFocusKey(row.key) }}
                  onUndo={() => undoOne(row)} onReviewFromHere={canDecide ? () => enter(row.key) : undefined} />
              )
            }} />
        )}
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announce}</p>
      {toast && (
        <div className="absolute right-3 bottom-3 left-3 z-20">
          <Toast key={toast.id} message={toast.message} action={toast.action} onDismiss={dismissToast} onHoldChange={holdToast} className="w-full" />
        </div>
      )}
      {menuOpen && (
        <ResultsMenu items={[
          ...(reviewed ? [] : [{ label: 'Export…', onSelect: () => { setMenuOpen(false); setExportOpen(true) } }]),
          { label: codeView ? 'Back to review' : 'Values as code', onSelect: () => { setMenuOpen(false); setCodeView((shown) => !shown) } },
          { label: selectedRow ? `Edit field ${selectedRow.name} in the schema…` : 'Edit field in the schema…',
            disabled: selectedRow && selectedNode && onEditField ? null : 'Select a value first',
            onSelect: () => { setMenuOpen(false); if (selectedRow && selectedNode) onEditField?.(selectedNode.id, selectedRow.resultPath) } },
        ]} />
      )}
      {/* Opened from ⋯ until the review is saved; then it is the status line's own button. */}
      {!reviewed && <div className="absolute top-0 right-0 size-0">{exportControl}</div>}
      {drawer !== null && attempt && (
        <RunDetailsDrawer attempt={attempt} section={drawer === 'open' ? null : drawer} recordCount={model?.records.length ?? 0}
          usedSchema={pinnedSchema} usedRevision={pinnedSchema?.revisionNumber ?? null} currentRevision={currentSchemaRevision?.revisionNumber ?? null}
          linkCounts={linkCounts} doubtful={counts.doubtful} returnFocusRef={detailsRef} recordsInResult={records?.length ?? 1}
          review={`${counts.approved} approved · ${counts.edited} edited · ${counts.rejected} rejected · ${reviewed ? 'review saved, read-only' : running ? 'draft until the run finishes' : 'draft saved'}`}
          onShowValue={(resultPath) => {
            setDrawer(null)
            const key = resultPathKey(resultPath)
            const record = model?.records.find((record) => record.rows.some((row) => row.key === key))
            if (record) setToggles((current) => new Map(current).set(record.index, true))
            setFilter('all')
            setSelectedKey(key)
            setFocusKey(key)
          }}
          onClose={() => setDrawer(null)} />
      )}
      {confirming && (
        <ModalDialog ariaLabel="Approve the rest and save the review" onDismiss={() => setConfirming(false)}
          className="m-auto w-96 max-w-[90vw] rounded-md border border-line bg-surface p-4 text-ink shadow-float backdrop:bg-ink/35">
          <p className="m-0 mb-1.5 text-content font-bold">Approve the {counts.toCheck} values still to check and save the review?</p>
          <p className="m-0 mb-1.5 text-secondary">{scope}</p>
          <p className="m-0 mb-2.5 text-secondary text-ink-muted">Filters don’t limit this. Your edits and rejections stay as they are. Saving makes the review read-only, so this can’t be undone.</p>
          {editOpen && <p className="m-0 mb-2.5 text-secondary text-danger">Finish or cancel the edit in progress first.</p>}
          <div className="flex gap-2">
            <Button variant="outline-positive" size="md" disabled={editOpen} onClick={() => {
              const approved = counts.toCheck
              setConfirming(false)
              review.approveAll()
              void save(`Approved ${approved} values. Review saved; it is now read-only.`)
            }}>Approve {counts.toCheck} and save review</Button>
            <Button size="md" onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        </ModalDialog>
      )}
    </div>
  )
}

export default ResultsTab
