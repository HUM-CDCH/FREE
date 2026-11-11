import { stopBatchExtraction } from '../stopBatchExtraction'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExportChoices, ExportFormat } from 'extraction-result-export'
import type { NavigableRoute } from '../projectNavigation'
import { getSchemaRevision, listSchemaRevisions } from '../schemaRevisions'
import type { SchemaRevision } from '../../shared/schemaRevision.contract'
import { Button } from '../ui'
import {
  BATCH_EXTRACTION_SELECTION_LIMIT,
  batchExtractionProgress,
  type BatchExtraction,
} from '../../shared/batchExtraction.contract'
import { recordScopeOf, strategyOf } from 'extraction/schema'
import type { ExtractionStrategy } from '../../shared/extraction.contract'
import PlusIcon from '../PlusIcon'
import { savedMethodFor, useSavedMethod } from '../savedMethod'
import { SavedMethodSummary } from '../SavedMethodSummary'
import { BatchRequestError, listBatchExtractions, openBatchExtraction } from './batchExtractions'
import type { ProjectContext } from './transport'
import { BatchPreparation, type PreparationKind } from './BatchPreparation'
import {
  BatchExtractionHistory,
  BatchExtractionMembers,
} from './BatchExtractionScreens'
import BatchReviewGrid from './BatchReviewGrid'

type Screen = 'history' | 'prepare' | 'members' | 'grid'

type SourceDocument = {
  sourceDocumentId: string
  name: string
  pageCount: number | null
}

/** A read is loading while it has neither answered nor failed. */
type Read<T> = { value: T | null; failure: string | null }

const reading = <T,>(read: Read<T>) =>
  read.value === null && read.failure === null

function failureText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** Refusals said with the saved-method summary: the saved advanced settings changed after it was shown, or the
 *  strategy is not the schema's saved Article/Catalog scope. Nothing started. */
const METHOD_REFUSALS: ReadonlySet<string> = new Set([
  'method_changed',
  'catalog_migration_required',
  'record_scope_required',
  'record_scope_mismatch',
])

function methodChanged(error: unknown): error is BatchRequestError {
  return error instanceof BatchRequestError && error.code !== null && METHOD_REFUSALS.has(error.code)
}

const STRATEGY_NAME: Readonly<Record<ExtractionStrategy, string>> = { ARTICLE: 'Article', CATALOG: 'Catalog' }

function stamp(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function batchRunning(batch: BatchExtraction): boolean {
  return batch.executionStatus === 'QUEUED' || batch.executionStatus === 'RUNNING'
}

function newestBatchFirst(left: BatchExtraction, right: BatchExtraction): number {
  return (
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    right.batchExtractionId.localeCompare(left.batchExtractionId)
  )
}

/** One preparation of a new Batch Extraction: how it was entered, and what it opens on. Each one is a new session, so
 *  its screen mounts fresh and a response to an earlier one never acts on it. */
type Preparing = {
  kind: PreparationKind
  schemaRevisionId: string | null
  selected: readonly string[]
  session: number
}

/**
 * The Extractions tab: past Batch Extractions, preparing a new one over selected Source Documents, and each one's
 * members, with its grid review, Run again, Stop and export. Extraction Results and single reviews open in the full
 * Source Document workspace.
 */
export default function BatchExtractionsPanel({
  projectContextId,
  sourceDocuments,
  openBatchExtractionId,
  openBatchExtractionView = null,
  pilotSchemaRevisionId,
  guidedRequest = null,
  onGuidedRequestHandled,
  summary = null,
  onNavigate,
  onProgressChange,
}: {
  projectContextId: string
  sourceDocuments: readonly SourceDocument[]
  /** The project's workflow position: which Schema Revision the guided pilot and batch run. */
  summary?: ProjectContext['summary'] | null
  /** The routed Batch Extraction, so one is linkable and survives a refresh. */
  openBatchExtractionId: string | null
  /** The routed view over that Batch Extraction: its review grid, else its documents. */
  openBatchExtractionView?: 'grid' | null
  /** Set right after approving a Schema Revision from the document workspace
   *  — opens straight into "Pilot Extraction" on this exact Revision. */
  pilotSchemaRevisionId: string | null
  /** The workflow bar's Next for a step whose work starts here (guided-workflow-phases): open the pilot or the
   *  collection-scale preparation on the Current Schema Revision, or the first result left to review, once what it
   *  needs has loaded. */
  guidedRequest?: 'pilot' | 'batch' | 'review' | null
  onGuidedRequestHandled?: () => void
  onNavigate: (route: NavigableRoute) => void
  onProgressChange?: () => void
}) {
  const sourceDocumentIds = sourceDocuments.map(
    (document) => document.sourceDocumentId,
  )
  const [preparing, setPreparing] = useState<Preparing | null>(null)
  const sessions = useRef(0)
  // Preparing a new Batch Extraction is a draft over whichever view is routed;
  // everything else follows the route.
  const screen: Screen = preparing
    ? 'prepare'
    : openBatchExtractionId
      ? openBatchExtractionView === 'grid' ? 'grid' : 'members'
      : 'history'
  // What is on screen now. A response that finishes after the researcher moved on (Back, another batch, another tab of
  // the project) records what it opened but leaves the screen alone.
  const shown = useRef<string | null>(null)
  const shownKey = `${screen}:${preparing?.session ?? openBatchExtractionId ?? ''}`
  useEffect(() => {
    shown.current = shownKey
    return () => {
      shown.current = null
    }
  }, [shownKey])
  const [batches, setBatches] = useState<Read<BatchExtraction[]>>({
    value: null,
    failure: null,
  })
  const [reload, setReload] = useState(0)
  const showHistory = useCallback(() => {
    setPreparing(null)
    onNavigate({ kind: 'project', projectContextId, tab: 'extractions' })
  }, [onNavigate, projectContextId])
  const startPreparing = (kind: PreparationKind, schemaRevisionId: string | null, selected: readonly string[]) => {
    setRunFailure(null)
    setRunFailureCode(null)
    setMethodConflict(null)
    setRunNotice(null)
    setPreparing({ kind, schemaRevisionId, selected, session: ++sessions.current })
  }
  const progress = batches.value && JSON.stringify(batches.value.map(batch => [
    batch.batchExtractionId, batch.executionStatus,
    batch.members.map(member => [member.extractionId, member.executionStatus, member.completed, member.currentReview]),
  ]))
  useEffect(() => {
    if (progress !== null) onProgressChange?.()
  }, [progress, onProgressChange])
  const [openingBatch, setOpeningBatch] = useState(false)
  const opening = useRef(false)
  // The account's saved method: a start submits what it saw, and admission refuses it if an Apply changed it since.
  const saved = useSavedMethod()
  const [runFailure, setRunFailure] = useState<string | null>(null)
  const [stoppingBatch, setStoppingBatch] = useState(false)
  // A Run again refused because the saved settings changed after the summary was shown: nothing started.
  const [methodConflict, setMethodConflict] = useState<string | null>(null)
  // Set when `runFailure` came from a known API error code (e.g. `schema_not_stabilised`), so the failure area can
  // offer a specific next step instead of just the message (guided-workflow-phases).
  const [runFailureCode, setRunFailureCode] = useState<string | null>(null)
  // A replayed selection reopens a Batch Extraction the researcher already has,
  // which is indistinguishable from nothing happening unless it is said.
  const [runNotice, setRunNotice] = useState<string | null>(null)
  const [pinnedBatchSchema, setPinnedBatchSchema] =
    useState<SchemaRevision | null>(null)
  const [pinnedBatchSchemaFailure, setPinnedBatchSchemaFailure] = useState<{
    schemaRevisionId: string
    message: string
  } | null>(null)
  const [pinnedBatchSchemaReload, setPinnedBatchSchemaReload] = useState(0)
  // The current revision of the open batch's schema, for Run again; unknown until read.
  const [pinnedSchemaCurrent, setPinnedSchemaCurrent] = useState<{
    extractionSchemaId: string
    schemaRevisionId: string
  } | null>(null)
  const [exportCoverage, setExportCoverage] = useState<{
    batchExtractionId: string
    message: string
  } | null>(null)
  const historyGeneration = useRef(0)
  const pendingRefresh = useRef(false)

  /** Stops the open Batch Extraction: each member still at work, as its own Stop would. */
  const stopOpenBatch = async (batch: BatchExtraction) => {
    setStoppingBatch(true)
    setRunFailure(null)
    try {
      await stopBatchExtraction([batch])
    } catch (error) {
      setRunFailure(error instanceof Error ? error.message : 'The Batch Extraction could not be stopped.')
    } finally {
      setStoppingBatch(false)
      setReload((value) => value + 1)
    }
  }

  const documentName = useCallback(
    (sourceDocumentId: string) =>
      sourceDocuments.find(
        (document) => document.sourceDocumentId === sourceDocumentId,
      )?.name ?? 'Source Document',
    [sourceDocuments],
  )

  useEffect(() => {
    const controller = new AbortController()
    const requestGeneration = ++historyGeneration.current
    pendingRefresh.current = true
    void listBatchExtractions(projectContextId, controller.signal).then(
      (listed) => {
        if (
          !controller.signal.aborted &&
          requestGeneration === historyGeneration.current
        )
          setBatches({ value: listed, failure: null })
      },
      (error: unknown) => {
        if (
          controller.signal.aborted ||
          requestGeneration !== historyGeneration.current
        )
          return
        setBatches({
          value: null,
          failure: failureText(error, 'Batch Extractions could not be read.'),
        })
      },
    ).finally(() => {
      pendingRefresh.current = false
    })
    return () => controller.abort()
  }, [projectContextId, reload])

  const working = batches.value?.some(batchRunning) ?? false
  useEffect(() => {
    const refresh = () => {
      if (!pendingRefresh.current) setReload((value) => value + 1)
    }
    window.addEventListener('focus', refresh)
    const interval = working ? window.setInterval(refresh, 2_000) : undefined
    return () => {
      window.removeEventListener('focus', refresh)
      window.clearInterval(interval)
    }
  }, [working])

  const batchList = batches.value ?? []
  const openBatch =
    batchList.find(
      (batch) => batch.batchExtractionId === openBatchExtractionId,
    ) ?? null
  const onBatchScreen = screen === 'members' || screen === 'grid'
  const pinnedExtractionSchemaId = onBatchScreen
    ? (openBatch?.extractionSchemaId ?? null)
    : null
  const pinnedSchemaRevisionId = onBatchScreen
    ? (openBatch?.schemaRevisionId ?? null)
    : null
  const currentPinnedBatchSchema =
    pinnedBatchSchema?.schemaRevisionId === pinnedSchemaRevisionId
      ? pinnedBatchSchema
      : null
  const currentPinnedBatchSchemaFailure =
    pinnedBatchSchemaFailure?.schemaRevisionId === pinnedSchemaRevisionId
      ? pinnedBatchSchemaFailure.message
      : null
  // Run again repeats the batch on its own Schema Revision under its own strategy, which admission accepts only while
  // that revision is its schema's current one and its scope names the strategy. A revision a later save replaced, or
  // one left undeclared (it ran as both Article and Catalog), runs again only as a New Batch Extraction.
  const runAgainRefusal = !openBatch
    ? null
    : pinnedSchemaCurrent?.extractionSchemaId === openBatch.extractionSchemaId &&
        pinnedSchemaCurrent.schemaRevisionId !== openBatch.schemaRevisionId
      ? `Template Revision ${openBatch.schemaRevisionNumber} is no longer the current revision of ${openBatch.extractionSchemaName}, so this Batch Extraction cannot run again. Start a New Batch Extraction with the template instead.`
      : currentPinnedBatchSchema &&
          currentPinnedBatchSchema.recordScope !== recordScopeOf(openBatch.strategy)
        ? `Template Revision ${openBatch.schemaRevisionNumber} ${currentPinnedBatchSchema.recordScope === null
          ? 'declares neither Article nor Catalog'
          : `is saved as ${STRATEGY_NAME[strategyOf(currentPinnedBatchSchema.recordScope)]}`}, so this Batch Extraction cannot run again as ${STRATEGY_NAME[openBatch.strategy]}. Start a New Batch Extraction with the template and choose Article or Catalog there.`
        : null
  // Read the pinned Schema Revision to check its record scope before Run again.
  useEffect(() => {
    if (!pinnedExtractionSchemaId || !pinnedSchemaRevisionId) return
    const controller = new AbortController()
    getSchemaRevision(
      projectContextId,
      pinnedExtractionSchemaId,
      pinnedSchemaRevisionId,
      controller.signal,
    ).then(
      (revision) => {
        if (!controller.signal.aborted) {
          setPinnedBatchSchema(revision)
          setPinnedBatchSchemaFailure(null)
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setPinnedBatchSchemaFailure({
            schemaRevisionId: pinnedSchemaRevisionId,
            message: failureText(
              error,
              'The pinned Template Revision could not be read.',
            ),
          })
      },
    )
    return () => controller.abort()
  }, [
    projectContextId,
    pinnedExtractionSchemaId,
    pinnedSchemaRevisionId,
    pinnedBatchSchemaReload,
  ])
  // The schema's newest revision is its current one. Unread, Run again stays offered and admission decides.
  useEffect(() => {
    if (!pinnedExtractionSchemaId || !pinnedSchemaRevisionId) return
    const controller = new AbortController()
    listSchemaRevisions(projectContextId, pinnedExtractionSchemaId, 1, controller.signal).then(
      ([newest]) => {
        if (!controller.signal.aborted && newest)
          setPinnedSchemaCurrent({ extractionSchemaId: pinnedExtractionSchemaId, schemaRevisionId: newest.schemaRevisionId })
      },
      () => {},
    )
    return () => controller.abort()
  }, [projectContextId, pinnedExtractionSchemaId, pinnedSchemaRevisionId, pinnedBatchSchemaReload])

  /** One table of every member's saved values at its own result and decision versions, each row named by its Source Document. */
  const exportOpenBatch = async (format: ExportFormat, choices: ExportChoices) => {
    if (!openBatch) return
    const { downloadDurableBatch } = await import('../durableExport')
    await downloadDurableBatch({ batchExtractionId: openBatch.batchExtractionId, name: openBatch.extractionSchemaName }, openBatch.members.map((member) => ({
      sourceDocumentId: member.sourceDocumentId, sourceDocumentName: documentName(member.sourceDocumentId), extractionId: member.extractionId,
      sourceRevisionId: member.sourceRepresentationRevisionId, status: member.executionStatus,
    })), format, choices)
    setExportCoverage({ batchExtractionId: openBatch.batchExtractionId, message: 'Exported every member’s saved values at its own result and review versions: one row per record, named by its Source Document. Recall is unmeasured.' })
  }
  const recordBatch = useCallback((batch: BatchExtraction) => {
    historyGeneration.current += 1
    setBatches((current) => ({
      value: [
        batch,
        ...(current.value ?? []).filter(
          (item) => item.batchExtractionId !== batch.batchExtractionId,
        ),
      ].sort(newestBatchFirst),
      failure: null,
    }))
  }, [])
  /** A Run from preparation session `session`: recorded always, shown only while that session is still on screen. */
  const acceptOpenedBatch = (session: number, opened: Awaited<ReturnType<typeof openBatchExtraction>>) => {
    recordBatch(opened.batchExtraction)
    if (shown.current !== `prepare:${session}`) return
    setPreparing(null)
    if (opened.disposition === 'replayed') {
      setRunNotice('This selection had already been run. Its existing Batch Extraction is open below; choose Run again to run the same selection fresh.')
      openMembers(opened.batchExtraction)
    } else showHistory()
  }

  /**
   * Runs the open Batch Extraction's selection again as its own Batch
   * Extraction. The stored one is immutable research state, so a rerun is a new
   * Batch Extraction over the same Source Documents rather than an overwrite.
   */
  const runOpenBatchAgain = async (batch: BatchExtraction) => {
    if (opening.current || saved.state.status !== 'ready') return
    // A fresh run of the stored selection: its strategy, with today's saved method.
    const method = savedMethodFor(saved.state, batch.strategy, null)
    const from = shown.current
    opening.current = true
    setOpeningBatch(true)
    setRunFailure(null)
    setMethodConflict(null)
    setRunFailureCode(null)
    setRunNotice(null)
    try {
      const opened = await openBatchExtraction({
        projectContextId,
        schemaRevisionId: batch.schemaRevisionId,
        // A rerun repeats the stored Batch Extraction, including its strategy.
        strategy: batch.strategy,
        sourceDocumentIds: batch.members.map(
          (member) => member.sourceDocumentId,
        ),
        force: true,
        method,
      })
      recordBatch(opened.batchExtraction)
      if (shown.current === from) openMembers(opened.batchExtraction)
    } catch (error) {
      if (shown.current !== from) return
      if (methodChanged(error)) setMethodConflict(error.message)
      else setRunFailure(failureText(error, 'The Batch Extraction could not be run again.'))
      setRunFailureCode(error instanceof BatchRequestError ? error.code ?? null : null)
    } finally {
      opening.current = false
      setOpeningBatch(false)
    }
  }

  const openMembers = (batch: BatchExtraction) => {
    setPreparing(null)
    onNavigate({
      kind: 'project',
      projectContextId,
      tab: 'extractions',
      batchExtractionId: batch.batchExtractionId,
    })
  }

  /** The workflow's pilot: the preparation screen on the Current Schema Revision with a small (2-3) Source Document
   *  selection pre-picked, so a researcher can start piloting in one click — still free to change the selection before
   *  running (guided-workflow-phases). */
  const beginPilotExtraction = (revisionId: string | null) =>
    startPreparing('pilot', revisionId, sourceDocumentIds.slice(0, Math.min(3, sourceDocumentIds.length)))

  // A Schema Revision just approved from the document workspace hands off here via `pilotSchemaRevisionId`
  // (guided-pilot-extraction-workflow): open straight into "Pilot Extraction" on that exact Revision. The hand-off
  // usually lands while the project's Source Documents are still loading, so it waits for them instead of being spent
  // on an empty list.
  const hasSourceDocuments = sourceDocumentIds.length > 0
  const handledPilotRevisionId = useRef<string | null>(null)
  useEffect(() => {
    if (!pilotSchemaRevisionId || !hasSourceDocuments) return
    if (handledPilotRevisionId.current === pilotSchemaRevisionId) return
    handledPilotRevisionId.current = pilotSchemaRevisionId
    // A one-shot hand-off from the document workspace's "Approve schema and go to next step".
    beginPilotExtraction(pilotSchemaRevisionId)
    // Only the hand-off id and the documents' arrival should retrigger this;
    // `sourceDocumentIds` just needs to be readable once it fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pilotSchemaRevisionId, hasSourceDocuments])

  const openBatchHasSuccessfulResult = openBatch?.members.some((member) => member.reviewable) ?? false
  // Both screens depend on the list read: a routed Batch Extraction is reached
  // before it has been read, and until then the batch is unknown, not missing.
  const batchesUnread = reading(batches) ? (
    <p className="py-6 text-center text-xs text-ink-muted" aria-busy="true">
      Loading Batch Extractions…
    </p>
  ) : batches.failure ? (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <p className="text-xs text-danger [overflow-wrap:anywhere]" role="alert">
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
  ) : null
  const heading =
    screen === 'history'
      ? 'History'
      : screen === 'prepare'
        ? 'New Batch Extraction'
        : openBatch
          ? stamp(openBatch.createdAt)
          : 'Batch Extraction'
  // The "← Back to history" header reads as a second, conflicting framing on
  // top of the pilot banner below it (which already explains what's
  // happening and offers its own way out), so it's left out entirely here.
  const isPilotPrepare = preparing?.kind === 'pilot'

  /** Opens the batch's first member still waiting for review, with the way
   *  back here and on to the next member. */
  const reviewBatch = (batch: BatchExtraction) => {
    const member = batch.members.find(
      (candidate) => candidate.reviewable && !candidate.currentReview,
    )
    onNavigate(
      member
        ? {
            kind: 'document',
            projectContextId,
            sourceDocumentId: member.sourceDocumentId,
            extractionId: member.extractionId,
            fromBatchExtractionId: batch.batchExtractionId,
          }
        : {
            kind: 'project',
            projectContextId,
            tab: 'extractions',
            batchExtractionId: batch.batchExtractionId,
          },
    )
  }

  const prepareCollectionRun = (revisionId: string) =>
    startPreparing('batch', revisionId, sourceDocumentIds.length > BATCH_EXTRACTION_SELECTION_LIMIT ? [] : sourceDocumentIds)

  // The workflow bar's Next lands here once what it opens has loaded.
  const batchesRead = batches.value !== null
  const handledGuidedRequest = useRef<typeof guidedRequest>(null)
  useEffect(() => {
    if (!guidedRequest) {
      handledGuidedRequest.current = null
      return
    }
    if (handledGuidedRequest.current === guidedRequest) return
    if (guidedRequest === 'review' ? !batchesRead : !hasSourceDocuments) return
    handledGuidedRequest.current = guidedRequest
    onGuidedRequestHandled?.()
    const revisionId = summary?.currentSchemaRevisionId ?? null
    // A one-shot hand-off from the workflow bar, like the pilot hand-off above.
    if (guidedRequest === 'pilot') beginPilotExtraction(revisionId)
    else if (guidedRequest === 'batch') {
      if (revisionId) prepareCollectionRun(revisionId)
    } else {
      const unreviewed = (batches.value ?? [])
        .toSorted(newestBatchFirst)
        .find((batch) => !batchRunning(batch) && batchExtractionProgress(batch).needsReview > 0)
      if (unreviewed) reviewBatch(unreviewed)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      else showHistory()
    }
    // Only a new request, or the data it waits for arriving, should act.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guidedRequest, hasSourceDocuments, batchesRead])

  return (
    <div
      id="project-extractions-panel"
      className="flex flex-col pt-1"
    >
      {!isPilotPrepare && (
        <div
          className={`flex shrink-0 min-h-10 justify-between gap-3 ${
            screen === 'history'
              ? 'mb-2 items-start pt-4'
              : 'mb-4 items-center border-b border-line pb-3'
          }`}
        >
          <div className="flex min-w-0 items-center gap-3">
            {screen !== 'history' && (
              <button
                className="shrink-0 rounded-md text-xs font-semibold text-ink-muted outline-none hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                type="button"
                disabled={openingBatch}
                onClick={showHistory}
              >
                <span aria-hidden="true">← </span>Back to history
              </button>
            )}
            {screen === 'history' ? (
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">
                  {heading}
                </span>
                <span className="mt-0.5 block text-xs text-ink-faint">
                  View and monitor your Batch Extraction runs.
                </span>
              </span>
            ) : (
              <p className="min-w-0 truncate text-sm font-semibold text-ink" title={heading}>{heading}</p>
            )}
          </div>
          {/* On `prepare` these only reopen the screen already shown. */}
          {screen !== 'prepare' && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="md"
                disabled={openingBatch}
                title="Advanced: choose the template and Source Documents yourself, outside the guided workflow."
                onClick={() => startPreparing('custom', null, sourceDocumentIds)}
              >
                {openingBatch ? (
                  'Opening Batch Extraction…'
                ) : (
                  <>
                    <PlusIcon />
                    Custom Batch Extraction
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      )}
      {runFailure && (
        <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
          <p className="min-w-0 text-[11px] leading-snug text-danger [overflow-wrap:anywhere]" role="alert">
            {runFailure}
          </p>
          {runFailureCode === 'schema_not_stabilised' && (
            <p className="text-[11px] leading-snug text-ink-muted">
              Approve the template in the chat, then run again.
            </p>
          )}
        </div>
      )}
      {runNotice && (
        <p className="mb-3 shrink-0 text-[11px] leading-snug text-ink-muted [overflow-wrap:anywhere]" role="status">
          {runNotice}
        </p>
      )}

      <div className="min-h-[430px]">
        {screen === 'history' ? (
          batchesUnread ? (
            batchesUnread
          ) : (
            <BatchExtractionHistory batches={batchList} onOpen={openMembers} />
          )
        ) : preparing ? (
          <BatchPreparation
            key={preparing.session}
            projectContextId={projectContextId}
            sourceDocuments={sourceDocuments}
            batches={batchList}
            kind={preparing.kind}
            initialSchemaRevisionId={preparing.schemaRevisionId}
            initialSelection={preparing.selected}
            saved={saved}
            onCancel={showHistory}
            onOpened={(opened) => acceptOpenedBatch(preparing.session, opened)}
          />
        ) : batchesUnread ? (
          batchesUnread
        ) : !openBatch ? (
          <p className="py-6 text-center text-xs text-ink-muted">
            That Batch Extraction is no longer listed.
          </p>
        ) : screen === 'grid' ? (
          <BatchReviewGrid
            key={openBatch.batchExtractionId}
            batch={openBatch}
            schemaNodes={currentPinnedBatchSchema?.schemaNodes ?? []}
            documentName={documentName}
            onBack={() => onNavigate({ kind: 'project', projectContextId, tab: 'extractions', batchExtractionId: openBatch.batchExtractionId })}
            onOpenMember={(sourceDocumentId, extractionId) =>
              onNavigate({ kind: 'document', projectContextId, sourceDocumentId, extractionId, fromBatchExtractionId: openBatch.batchExtractionId })
            }
            onFinalized={() => setReload((value) => value + 1)}
          />
        ) : (
          <BatchExtractionMembers
            batch={openBatch}
            pinnedSchemaFailure={currentPinnedBatchSchemaFailure}
            hasSuccessfulResult={openBatchHasSuccessfulResult}
            coverageMessage={
              exportCoverage?.batchExtractionId === openBatch.batchExtractionId
                ? exportCoverage.message
                : null
            }
            opening={openingBatch}
            canRunAgain={saved.state.status === 'ready'}
            runAgainRefusal={runAgainRefusal}
            runAgainMethod={
              <SavedMethodSummary saved={saved.state} conflict={methodConflict}
                method={saved.state.status === 'ready' ? savedMethodFor(saved.state, openBatch.strategy, null) : null}
                onRefresh={() => { setMethodConflict(null); void saved.refresh() }} />
            }
            documentName={documentName}
            exportSchemaNodes={currentPinnedBatchSchema?.schemaNodes ?? []}
            onExport={exportOpenBatch}
            onRetrySchema={() =>
              setPinnedBatchSchemaReload((value) => value + 1)
            }
            onRunAgain={() => void runOpenBatchAgain(openBatch)}
            onStop={() => void stopOpenBatch(openBatch)}
            stopping={stoppingBatch}
            onOpenGridReview={() =>
              onNavigate({ kind: 'project', projectContextId, tab: 'extractions', batchExtractionId: openBatch.batchExtractionId, view: 'grid' })
            }
            onOpenMember={(sourceDocumentId, extractionId) =>
              onNavigate({
                kind: 'document',
                projectContextId,
                sourceDocumentId,
                extractionId,
                // The document offers its way back here and the pilot round's next member.
                fromBatchExtractionId: openBatch.batchExtractionId,
              })
            }
          />
        )}
      </div>
    </div>
  )
}