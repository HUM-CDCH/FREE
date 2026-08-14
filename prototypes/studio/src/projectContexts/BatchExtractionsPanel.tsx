import { useCallback, useEffect, useRef, useState } from 'react'
import { requestExtraction } from '../api'
import type { NavigableRoute } from '../projectNavigation'
import { listExtractionSchemas } from '../schemaRevisions'
import { Button } from '../ui'
import {
  BATCH_EXTRACTION_SELECTION_LIMIT,
  batchExtractionProgress,
  type BatchExtraction,
  type BatchExtractionMember,
} from '../../shared/batchExtraction.contract'
import type {
  ExtractionStrategy,
} from '../../shared/extraction.contract'
import { listBatchExtractions, openBatchExtraction } from './batchExtractions'

type Screen = 'history' | 'prepare' | 'members'

type SourceDocument = {
  sourceDocumentId: string
  name: string
  pageCount: number | null
}

type ExtractionSchemas = Awaited<ReturnType<typeof listExtractionSchemas>>

/** A read is loading while it has neither answered nor failed. */
type Read<T> = { value: T | null; failure: string | null }

const reading = <T,>(read: Read<T>) =>
  read.value === null && read.failure === null

const control =
  'rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30'

const strategies: { value: ExtractionStrategy; label: string }[] = [
  { value: 'ARTICLE', label: 'Article' },
  { value: 'CATALOG', label: 'Catalog' },
]

function failureText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function stamp(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/** What one member is, read only from what the server stored for it. */
function memberStatus(member: BatchExtractionMember): {
  label: string
  tone: string
  message: string | null
} {
  const extraction = member.latestExtraction
  if (!extraction)
    return { label: 'Not run', tone: 'text-ink-faint', message: null }
  if (extraction.outcome === 'FAILED')
    return {
      label: 'Failed',
      tone: 'text-danger',
      message:
        extraction.failureMessage ??
        'The Extraction failed without a recorded reason.',
    }
  if (extraction.outcome === 'CANCELLED')
    return {
      label: 'Cancelled',
      tone: 'text-ink-muted',
      message: 'The Extraction was cancelled before completion.',
    }
  if (!extraction.reviewable)
    return {
      label: 'Completed without review',
      tone: 'text-ink-muted',
      message: 'No validated Evidence is available, so this result cannot be reviewed.',
    }
  return extraction.reviewedAt
    ? { label: 'Reviewed', tone: 'text-success', message: null }
    : { label: 'Needs review', tone: 'text-accent', message: null }
}

/** One Batch Extraction's state as a sentence, counted from its members. */
function batchStatus(batch: BatchExtraction, running: boolean) {
  const progress = batchExtractionProgress(batch)
  if (running)
    return {
      label: `Running · ${progress.extracted} of ${progress.total}`,
      tone: 'text-accent',
    }
  const parts = [
    progress.pending ? `${progress.pending} not run` : null,
    progress.needsReview ? `${progress.needsReview} need review` : null,
    progress.unreviewable
      ? `${progress.unreviewable} complete without review`
      : null,
    progress.failed ? `${progress.failed} failed` : null,
    progress.cancelled ? `${progress.cancelled} cancelled` : null,
  ].filter((part): part is string => part !== null)
  if (parts.length === 0) return { label: 'Reviewed', tone: 'text-success' }
  return {
    label: parts.join(' · '),
    tone: progress.failed ? 'text-danger' : 'text-accent',
  }
}

function schemaLine(batch: BatchExtraction): string {
  return `${batch.extractionSchemaName} · Schema Revision ${batch.schemaRevisionNumber}`
}

function selectionLine(batch: BatchExtraction): string {
  const count = batch.members.length
  const strategy = strategies.find((item) => item.value === batch.strategy)
  return `${count} Source Document${count === 1 ? '' : 's'} · ${strategy?.label ?? batch.strategy}`
}

/**
 * The Extractions tab: past Batch Extractions, opening a new one over selected
 * Source Documents, and their persisted member history. Extraction Results and
 * reviews open in the full Source Document workspace.
 */
export default function BatchExtractionsPanel({
  projectContextId,
  sourceDocuments,
  onNavigate,
}: {
  projectContextId: string
  sourceDocuments: readonly SourceDocument[]
  onNavigate: (route: NavigableRoute) => void
}) {
  const [screen, setScreen] = useState<Screen>('history')
  const [batches, setBatches] = useState<Read<BatchExtraction[]>>({
    value: null,
    failure: null,
  })
  const [reload, setReload] = useState(0)
  const [openBatchId, setOpenBatchId] = useState<string | null>(null)
  const [runningBatchId, setRunningBatchId] = useState<string | null>(null)
  const [openingBatch, setOpeningBatch] = useState(false)
  const [runFailure, setRunFailure] = useState<string | null>(null)
  const [schemas, setSchemas] = useState<Read<ExtractionSchemas>>({
    value: null,
    failure: null,
  })
  const [schemaRevisionId, setSchemaRevisionId] = useState('')
  const [strategy, setStrategy] = useState<ExtractionStrategy>('ARTICLE')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [filter, setFilter] = useState('')
  const opening = useRef(false)
  // The run outlives screen changes; a second action never replaces it.
  const run = useRef<AbortController | null>(null)
  useEffect(() => () => run.current?.abort(), [])

  const documentsById = new Map(
    sourceDocuments.map((document) => [document.sourceDocumentId, document]),
  )
  const documentName = (sourceDocumentId: string) =>
    documentsById.get(sourceDocumentId)?.name ?? 'Source Document'

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const listed = await listBatchExtractions(projectContextId, signal)
      if (!signal?.aborted) setBatches({ value: listed, failure: null })
      return listed
    },
    [projectContextId],
  )

  useEffect(() => {
    const controller = new AbortController()
    listBatchExtractions(projectContextId, controller.signal).then(
      (listed) => {
        if (!controller.signal.aborted)
          setBatches({ value: listed, failure: null })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setBatches({
          value: null,
          failure: failureText(error, 'Batch Extractions could not be read.'),
        })
      },
    )
    return () => controller.abort()
  }, [projectContextId, reload])

  useEffect(() => {
    if (screen !== 'prepare') return
    const controller = new AbortController()
    listExtractionSchemas(projectContextId, undefined, controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return
        setSchemas({ value, failure: null })
        setSchemaRevisionId(
          (current) =>
            current ||
            value.find((schema) => schema.currentRevision)?.currentRevision
              ?.schemaRevisionId ||
            '',
        )
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setSchemas({
          value: null,
          failure: failureText(error, 'Schemas could not be read.'),
        })
      },
    )
    return () => controller.abort()
  }, [projectContextId, screen])

  const batchList = batches.value ?? []
  const openBatch =
    batchList.find((batch) => batch.batchExtractionId === openBatchId) ?? null

  /**
   * Runs one member at a time: the Extraction route answers only when its
   * Extraction is terminal, and the model serves one request at a time. Each
   * terminal write is re-read, so progress shows what is persisted.
   */
  const runMembers = async (
    batch: BatchExtraction,
    members: readonly BatchExtractionMember[],
  ) => {
    if (run.current) return
    const controller = new AbortController()
    run.current = controller
    setRunningBatchId(batch.batchExtractionId)
    setRunFailure(null)
    try {
      for (const member of members) {
        if (controller.signal.aborted) return
        try {
          await requestExtraction(
            {
              id: crypto.randomUUID(),
              sourceRepresentationRevisionId:
                member.sourceRepresentationRevisionId,
              schemaRevisionId: batch.schemaRevisionId,
              strategy: batch.strategy,
              batchExtractionId: batch.batchExtractionId,
            },
            controller.signal,
          )
        } catch (error) {
          if (controller.signal.aborted) return
          // A failed Extraction is persisted and read back below; only a request
          // that never reached a terminal write is reported here.
          setRunFailure(
            `${documentName(member.sourceDocumentId)}: ${failureText(error, 'Extraction failed.')}`,
          )
        }
        if (controller.signal.aborted) return
        await refresh(controller.signal).catch(() => {})
      }
    } finally {
      if (run.current === controller) {
        run.current = null
        setRunningBatchId(null)
      }
    }
  }

  const openNewBatch = async () => {
    if (opening.current || run.current) return
    opening.current = true
    setOpeningBatch(true)
    setRunFailure(null)
    try {
      const request = {
        projectContextId,
        schemaRevisionId,
        strategy,
        sourceDocumentIds: [...selected],
      }
      let opened = await openBatchExtraction(request)
      if (
        opened.disposition === 'running' &&
        window.confirm(
          'A Batch Extraction for this selection is already running. Run another batch?',
        )
      )
        opened = await openBatchExtraction({ ...request, force: true })
      const batch = opened.batchExtraction
      setBatches((current) =>
        current.value
          ? {
              value: [
                batch,
                ...current.value.filter(
                  (item) => item.batchExtractionId !== batch.batchExtractionId,
                ),
              ],
              failure: null,
            }
          : current,
      )
      setOpenBatchId(batch.batchExtractionId)
      setSelected(new Set())
      setScreen('history')
      opening.current = false
      setOpeningBatch(false)
      const members =
        opened.disposition === 'retry'
          ? batch.members.filter(
              (member) => member.latestExtraction?.outcome === 'FAILED',
            )
          : opened.disposition === 'created'
            ? batch.members
            : []
      if (members.length) await runMembers(batch, members)
    } catch (error) {
      setRunFailure(
        failureText(error, 'The Batch Extraction could not be opened.'),
      )
    } finally {
      if (opening.current) {
        opening.current = false
        setOpeningBatch(false)
      }
    }
  }

  const openMembers = (batch: BatchExtraction) => {
    setOpenBatchId(batch.batchExtractionId)
    setScreen('members')
  }

  const openProgress = openBatch
    ? batchExtractionProgress(openBatch)
    : {
        total: 0,
        extracted: 0,
        pending: 0,
        reviewed: 0,
        unreviewable: 0,
        failed: 0,
        cancelled: 0,
        needsReview: 0,
      }
  const filtered = sourceDocuments.filter((document) =>
    document.name
      .toLocaleLowerCase()
      .includes(filter.trim().toLocaleLowerCase()),
  )
  const overSelectionLimit = selected.size > BATCH_EXTRACTION_SELECTION_LIMIT
  const heading =
    screen === 'history'
      ? 'History'
      : screen === 'prepare'
        ? 'New Batch Extraction'
        : openBatch
          ? stamp(openBatch.createdAt)
          : 'Batch Extraction'

  return (
    <div
      id="project-extractions-panel"
      role="tabpanel"
      aria-labelledby="project-extractions-tab"
      className="pt-1"
      tabIndex={0}
    >
      <div className="mb-4 flex min-h-10 items-center justify-end">
        <Button
          variant={screen === 'members' ? 'secondary' : 'primary'}
          size="md"
          disabled={openingBatch || runningBatchId !== null}
          onClick={() => setScreen('prepare')}
        >
          {openingBatch ? 'Opening Batch Extraction…' : 'New Batch Extraction'}
        </Button>
      </div>
      <div className="mb-3 flex min-h-10 items-center justify-between gap-3 py-2">
        <p className="text-xs font-semibold text-ink">{heading}</p>
        {screen !== 'history' && (
          <button
            className="rounded-md text-xs font-semibold text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40"
            type="button"
            onClick={() => setScreen('history')}
          >
            <span aria-hidden="true">← </span>Back to history
          </button>
        )}
      </div>
      {runFailure && (
        <p className="mb-3 text-[11px] leading-snug text-danger" role="alert">
          {runFailure}
        </p>
      )}

      <div className="min-h-[430px]">
        {screen === 'history' ? (
          reading(batches) ? (
            <p className="py-6 text-center text-xs text-ink-muted" aria-busy="true">
              Loading Batch Extractions…
            </p>
          ) : batches.failure ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <p className="text-xs text-danger" role="alert">
                Could not load Batch Extractions. {batches.failure}
              </p>
              <Button
                onClick={() => {
                  setBatches({ value: null, failure: null })
                  setReload((attempt) => attempt + 1)
                }}
              >
                Retry
              </Button>
            </div>
          ) : batchList.length === 0 ? (
            <p className="py-6 text-center text-xs text-ink-muted">
              No Batch Extractions yet.
            </p>
          ) : (
            <ul className="space-y-1" aria-live="polite">
              {batchList.map((batch) => {
                const status = batchStatus(
                  batch,
                  runningBatchId === batch.batchExtractionId,
                )
                return (
                  <li key={batch.batchExtractionId}>
                    <button
                      className="grid w-full grid-cols-1 items-center gap-2 rounded-md px-2 py-3 text-left outline-none hover:bg-line/20 focus-visible:ring-2 focus-visible:ring-accent/40 sm:grid-cols-[1fr_auto] sm:gap-6"
                      type="button"
                      onClick={() => openMembers(batch)}
                    >
                      <span>
                        <strong className="block text-xs text-ink">
                          <time dateTime={batch.createdAt}>
                            {stamp(batch.createdAt)}
                          </time>
                        </strong>
                        <span className="mt-1 block text-[11px] text-ink-muted">
                          {schemaLine(batch)}
                        </span>
                        <span className="block text-[11px] text-ink-faint">
                          {selectionLine(batch)}
                        </span>
                      </span>
                      <span
                        className={`text-[11px] font-semibold ${status.tone}`}
                      >
                        {status.label}
                        <span className="ml-3 text-ink-faint" aria-hidden="true">
                          ›
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )
        ) : screen === 'prepare' ? (
          <>
            <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-[11px] font-semibold text-ink-muted">
                Extraction Schema
                <select
                  className={`${control} mt-1 block w-full font-normal`}
                  value={schemaRevisionId}
                  disabled={schemas.value === null}
                  onChange={(event) => setSchemaRevisionId(event.target.value)}
                >
                  {schemas.value ? (
                    schemas.value.flatMap((schema) =>
                      schema.currentRevision
                        ? [
                            <option
                              key={schema.extractionSchemaId}
                              value={schema.currentRevision.schemaRevisionId}
                            >
                              {schema.name} · Schema Revision{' '}
                              {schema.currentRevision.revisionNumber}
                            </option>,
                          ]
                        : [],
                    )
                  ) : (
                    <option value="">
                      {schemas.failure ? 'Schemas unavailable' : 'Loading schemas…'}
                    </option>
                  )}
                </select>
              </label>
              <label className="text-[11px] font-semibold text-ink-muted">
                Extraction Strategy
                <select
                  className={`${control} mt-1 block w-full font-normal`}
                  value={strategy}
                  onChange={(event) =>
                    setStrategy(event.target.value as ExtractionStrategy)
                  }
                >
                  {strategies.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {schemas.failure && (
              <p className="mb-3 text-[11px] text-danger" role="alert">
                {schemas.failure}
              </p>
            )}
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
              <div>
                <h3 className="text-xs font-bold text-ink">Source Documents</h3>
                <p className="text-[11px] text-ink-faint">
                  {selected.size} selected
                </p>
              </div>
              <input
                className={`${control} w-full sm:w-48`}
                type="search"
                aria-label="Filter Source Documents"
                placeholder="Filter Source Documents"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </div>
            {filtered.length === 0 ? (
              <p className="py-6 text-center text-xs text-ink-muted">
                {sourceDocuments.length === 0
                  ? 'No Source Documents yet. Add Source Documents on the Sources tab.'
                  : `No Source Documents match “${filter}”.`}
              </p>
            ) : (
              <ul className="space-y-1">
                {filtered.map((document) => (
                  <li key={document.sourceDocumentId}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-md px-1 py-3 hover:bg-line/20">
                      <input
                        className="size-3.5 accent-accent"
                        type="checkbox"
                        checked={selected.has(document.sourceDocumentId)}
                        onChange={() =>
                          setSelected((current) => {
                            const next = new Set(current)
                            if (next.has(document.sourceDocumentId))
                              next.delete(document.sourceDocumentId)
                            else next.add(document.sourceDocumentId)
                            return next
                          })
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold text-ink">
                          {document.name}
                        </span>
                        {document.pageCount !== null && (
                          <span className="block text-[11px] text-ink-faint">
                            {document.pageCount}{' '}
                            {document.pageCount === 1 ? 'page' : 'pages'}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {overSelectionLimit && (
              <p className="mt-4 text-[11px] text-danger" role="alert">
                One Batch Extraction takes at most{' '}
                {BATCH_EXTRACTION_SELECTION_LIMIT} Source Documents.
              </p>
            )}
            <div className="mt-4 flex justify-end">
              <Button
                variant="primary"
                size="md"
                disabled={
                  selected.size === 0 ||
                  !schemaRevisionId ||
                  overSelectionLimit ||
                  openingBatch ||
                  runningBatchId !== null
                }
                onClick={openNewBatch}
              >
                {openingBatch ? 'Opening…' : 'Run'} {selected.size} Source Document
                {selected.size === 1 ? '' : 's'}
              </Button>
            </div>
          </>
        ) : !openBatch ? (
          <p className="py-6 text-center text-xs text-ink-muted">
            That Batch Extraction is no longer listed.
          </p>
        ) : (
          <>
            <div className="mb-5 flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-end">
              <p className="text-[11px] text-ink-faint">
                {schemaLine(openBatch)} ·{' '}
                {strategies.find((item) => item.value === openBatch.strategy)
                  ?.label ?? openBatch.strategy}
              </p>
              <p
                className={`text-xs font-semibold ${
                  openProgress.failed
                    ? 'text-danger'
                    : openProgress.needsReview
                      ? 'text-accent'
                      : 'text-ink-muted'
                }`}
              >
                {openProgress.reviewed} reviewed · {openProgress.unreviewable}{' '}
                complete without review · {openProgress.failed} failed ·{' '}
                {openProgress.cancelled} cancelled
              </p>
            </div>
            <ul className="space-y-1" aria-label="Batch Extraction members">
              {openBatch.members.map((member) => {
                const status = memberStatus(member)
                return (
                  <li key={member.sourceDocumentId}>
                    <button
                      className="w-full rounded-md px-2 py-3 text-left outline-none hover:bg-line/20 focus-visible:ring-2 focus-visible:ring-accent/40"
                      type="button"
                      onClick={() =>
                        onNavigate({
                          kind: 'document',
                          projectContextId,
                          sourceDocumentId: member.sourceDocumentId,
                          ...(member.latestExtraction
                            ? {
                                extractionId:
                                  member.latestExtraction.extractionId,
                              }
                            : {}),
                        })
                      }
                    >
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate text-xs font-semibold text-ink">
                          {documentName(member.sourceDocumentId)}
                        </span>
                        <small className={`shrink-0 ${status.tone}`}>
                          {status.label}
                        </small>
                      </span>
                      {status.message && (
                        <span
                          className={`mt-1 block text-[11px] leading-snug ${status.tone}`}
                        >
                          {status.message}
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
