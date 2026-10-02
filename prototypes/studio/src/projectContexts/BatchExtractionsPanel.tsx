import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  exportBatchExtractionResults,
  type ExportChoices,
  type ExportFormat,
} from 'extraction-result-export'
import type { NavigableRoute } from '../projectNavigation'
import {
  getSchemaRevision,
  listExtractionSchemas,
  listSchemaRevisions,
} from '../schemaRevisions'
import type { SchemaRevision } from '../../shared/schemaRevision.contract'
import { Button } from '../ui'
import { contestedNotice } from '../ExtractionResultExportControl'
import { requestModelKeyResend } from '../auth/authenticatedFetch'
import {
  BATCH_EXTRACTION_SELECTION_LIMIT,
  type BatchExtraction,
} from '../../shared/batchExtraction.contract'
import {
  parseBatchSuggestionDefinition,
  recordScopeOf,
  strategyOf,
  type SchemaDefinition,
} from 'extraction/schema'
import type { BatchSchemaSuggestion } from '../../shared/batchSchemaSuggestion.contract'
import type { ExtractionStrategy } from '../../shared/extraction.contract'
import PlusIcon from '../PlusIcon'
import SchemaPanel from '../SchemaPanel'
import {
  createSchemaEditorController,
  localSchemaPersistence,
  type SchemaEditorController,
  type SchemaEditorSnapshot,
} from '../currentSchemaRevision'
import { sameSchemaDefinition } from '../schemaDefinitionEquality'
import {
  useDurableCurrentSchemaRevision,
  useSchemaEditorController,
} from '../useCurrentSchemaRevision'
import { savedMethodFor, useSavedMethod } from '../savedMethod'
import { SavedMethodSummary } from '../SavedMethodSummary'
import {
  BatchRequestError,
  getBatchExtractionResults,
  listBatchExtractions,
  listBatchSchemaSuggestions,
  openBatchExtraction,
} from './batchExtractions'
import { useBatchSchemaSuggestion } from './useBatchSchemaSuggestion'
import { sourceCoverageNotice, UNCOMBINED_NOTICE } from '../sourceCoverageNotice'
import {
  BatchExtractionHistory,
  BatchExtractionMembers,
} from './BatchExtractionScreens'
import BatchExtractionReviewGrid from './BatchExtractionReviewGrid'
import BatchExtractionFinishedDialog from './BatchExtractionFinishedDialog'

type Screen = 'history' | 'prepare' | 'members' | 'grid'

type SourceDocument = {
  sourceDocumentId: string
  name: string
  pageCount: number | null
}

/** A proposal's identity: every publication increments the draft version, and a retry starts the next attempt. */
type SuggestionDraftVersion = Pick<
  BatchSchemaSuggestion,
  'draftVersion' | 'attempt'
>

type ExtractionSchemas = Awaited<ReturnType<typeof listExtractionSchemas>>

const SUGGEST_SCHEMA = '__suggest_common_fields__'

/** A read is loading while it has neither answered nor failed. */
type Read<T> = { value: T | null; failure: string | null }


const reading = <T,>(read: Read<T>) =>
  read.value === null && read.failure === null

const control =
  'rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink outline-none focus-visible:border-accent'

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

/** Said wherever a start waits for the schema's Article/Catalog choice. */
const STRATEGY_HELP = 'Article: one object for the whole document. Catalog: a collection of records.'
const STRATEGY_NAME: Readonly<Record<ExtractionStrategy, string>> = { ARTICLE: 'Article', CATALOG: 'Catalog' }

const noSubscription = () => () => {}
const noSnapshot = (): SchemaEditorSnapshot | null => null

function stamp(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function newestBatchFirst(left: BatchExtraction, right: BatchExtraction): number {
  return (
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    right.batchExtractionId.localeCompare(left.batchExtractionId)
  )
}

function runnableSuggestionDefinition(value: unknown): boolean {
  try {
    parseBatchSuggestionDefinition(value)
    return true
  } catch {
    return false
  }
}

/** The suggestion's own failure, as one line. A missing key is named, because the page has just resent its keys and a
 *  retry can succeed; any other failure is FREE's own sanitized message. */
function suggestionFailureText(failure: { code: string; message: string }): string {
  return failure.code === 'model_key_required' ? 'Model key not available' : failure.message
}

/**
 * The Extractions tab: past Batch Extractions, opening a new one over selected
 * Source Documents, and their persisted member history. Extraction Results and
 * reviews open in the full Source Document workspace.
 */
export default function BatchExtractionsPanel({
  projectContextId,
  sourceDocuments,
  openBatchExtractionId,
  openBatchExtractionView,
  onNavigate,
}: {
  projectContextId: string
  sourceDocuments: readonly SourceDocument[]
  /** The routed Batch Extraction, so one is linkable and survives a refresh. */
  openBatchExtractionId: string | null
  /** The routed sub-view over that Batch Extraction, e.g. the review grid. */
  openBatchExtractionView: 'grid' | null
  onNavigate: (route: NavigableRoute) => void
}) {
  const sourceDocumentIds = sourceDocuments.map(
    (document) => document.sourceDocumentId,
  )
  const [preparing, setPreparing] = useState(false)
  // Preparing a new Batch Extraction is a draft over whichever view is routed;
  // everything else follows the route.
  const screen: Screen = preparing
    ? 'prepare'
    : openBatchExtractionId
      ? openBatchExtractionView === 'grid'
        ? 'grid'
        : 'members'
      : 'history'
  const showHistory = useCallback(() => {
    setPreparing(false)
    onNavigate({ kind: 'project', projectContextId, tab: 'extractions' })
  }, [onNavigate, projectContextId])
  const [batches, setBatches] = useState<Read<BatchExtraction[]>>({
    value: null,
    failure: null,
  })
  const [reload, setReload] = useState(0)
  // The last execution status observed for each Batch Extraction, so a
  // RUNNING/QUEUED -> terminal transition can be reported exactly once per
  // mount — a reload or reopened panel starts this fresh and never re-fires.
  const previousExecutionStatus = useRef<Map<string, string>>(new Map())
  const [finishedBatchReport, setFinishedBatchReport] =
    useState<BatchExtraction | null>(null)
  const [openingBatch, setOpeningBatch] = useState(false)
  // The account's saved method: a start submits what it saw, and admission refuses it if an Apply changed it since.
  const saved = useSavedMethod()
  const [runFailure, setRunFailure] = useState<string | null>(null)
  // A start refused because the saved settings changed after the summary was shown: nothing started.
  const [methodConflict, setMethodConflict] = useState<string | null>(null)
  // A replayed selection reopens a Batch Extraction the researcher already has,
  // which is indistinguishable from nothing happening unless it is said.
  const [runNotice, setRunNotice] = useState<string | null>(null)
  const [suggestionHasPendingLocalEdit, setSuggestionHasPendingLocalEdit] =
    useState(false)
  const [schemas, setSchemas] = useState<Read<ExtractionSchemas>>({
    value: null,
    failure: null,
  })
  const [schemaRevisionId, setSchemaRevisionId] = useState('')
  const [batchStrategy, setBatchStrategy] = useState<ExtractionStrategy>('ARTICLE')
  const [chosenSchema, setChosenSchema] = useState<SchemaRevision | null>(null)
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
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(sourceDocumentIds),
  )
  const [filter, setFilter] = useState('')
  const opening = useRef(false)
  // The saved-schema editor registers its controller so opening a Batch Extraction
  // can wait for the chosen schema's pending save, and the strategy select reads
  // and saves that schema's Article/Catalog scope.
  const [savedSchemaController, setSavedSchemaController] =
    useState<SchemaEditorController | null>(null)
  const savedSchemaSnap = useSyncExternalStore(
    savedSchemaController?.subscribe ?? noSubscription,
    savedSchemaController?.snapshot ?? noSnapshot,
  )
  const historyGeneration = useRef(0)
  const suggestionGeneration = useRef(0)
  const pendingRefreshes = useRef(0)
  const [suggestions, setSuggestions] = useState<Read<BatchSchemaSuggestion[]>>({
    value: null,
    failure: null,
  })
  const replaceSuggestion = useCallback((next: BatchSchemaSuggestion) => {
    suggestionGeneration.current += 1
    setSuggestions((current) => ({
      value: [
        next,
        ...(current.value ?? []).filter(
          (item) => item.batchSchemaSuggestionId !== next.batchSchemaSuggestionId,
        ),
      ],
      failure: null,
    }))
  }, [])
  const [suggestion, sendSuggestion] = useBatchSchemaSuggestion({
    projectContextId,
    onSuggestion: replaceSuggestion,
    onRun: () => {
      setSelected(new Set())
      showHistory()
      setReload((value) => value + 1)
    },
  })
  const activeSuggestion = suggestion.context.suggestion
  // A suggested-batch Run refused the same way is shown with the summary, not as the suggestion's failure.
  const suggestionMethodConflict =
    suggestion.context.runFailureCode !== null && METHOD_REFUSALS.has(suggestion.context.runFailureCode)
      ? suggestion.context.error
      : null
  const [seenSuggestionConflict, setSeenSuggestionConflict] = useState<string | null>(null)
  if (suggestionMethodConflict !== seenSuggestionConflict) {
    setSeenSuggestionConflict(suggestionMethodConflict)
    if (suggestionMethodConflict) setMethodConflict(suggestionMethodConflict)
  }
  const confirmedSuggestion =
    activeSuggestion?.confirmedSchemaRevisionId !== null
      ? activeSuggestion
      : null
  const suggestionProposal =
    activeSuggestion?.phase === 'READY' && suggestion.context.draft
      ? {
          status: 'ready' as const,
          selectionKey: activeSuggestion.selectionKey,
          ...suggestion.context.draft,
        }
      : activeSuggestion?.phase === 'HETEROGENEOUS'
        ? {
            status: 'heterogeneous' as const,
            selectionKey: activeSuggestion.selectionKey,
          }
        : null
  // Each Source Document suggestion made from excerpts or left out of the merge, said beside the proposal it fed (or the
  // heterogeneous outcome).
  const excerptNotices = suggestionProposal
    ? (activeSuggestion?.sourceCoverage ?? []).flatMap(({ sourceDocumentId, sourceCoverage, combined }) => {
        const statements = [
          sourceCoverage && sourceCoverageNotice(sourceCoverage),
          combined ? null : UNCOMBINED_NOTICE,
        ].filter((statement) => statement)
        if (statements.length === 0) return []
        const notice = statements.join(' ')
        const name = sourceDocuments.find((document) => document.sourceDocumentId === sourceDocumentId)?.name
        return [{ sourceDocumentId, text: `${name ?? 'A removed Source Document'}: ${notice}` }]
      })
    : []
  const draftConflict = suggestion.matches('conflict')
  const suggestionHasMembers = (activeSuggestion?.sources.length ?? 0) > 0

  // A background attempt that found no key reports model_key_required inside a 200 read, which authenticatedFetch's
  // 409 hook never sees: resend this page's keys once per such attempt, so the researcher's retry can succeed.
  const keysResentFor = useRef(new Set<string>())
  useEffect(() => {
    const keyless = [...(suggestions.value ?? []), ...(activeSuggestion ? [activeSuggestion] : [])]
      .filter((candidate) => candidate.failure?.code === 'model_key_required')
      .map((candidate) => `${candidate.batchSchemaSuggestionId}:${candidate.attempt}`)
      .filter((attempt) => !keysResentFor.current.has(attempt))
    if (keyless.length === 0) return
    for (const attempt of keyless) keysResentFor.current.add(attempt)
    requestModelKeyResend()
  }, [activeSuggestion, suggestions.value])

  const documentName = useCallback(
    (sourceDocumentId: string) =>
      sourceDocuments.find(
        (document) => document.sourceDocumentId === sourceDocumentId,
      )?.name ?? 'Source Document',
    [sourceDocuments],
  )

  const clearSuggestedFields = () => {
    sendSuggestion({ type: 'reset' })
  }

  useEffect(() => {
    const controller = new AbortController()
    const requestGeneration = ++historyGeneration.current
    pendingRefreshes.current += 1
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
      pendingRefreshes.current -= 1
    })
    return () => controller.abort()
  }, [projectContextId, reload])

  useEffect(() => {
    const controller = new AbortController()
    const requestGeneration = ++suggestionGeneration.current
    pendingRefreshes.current += 1
    void listBatchSchemaSuggestions(projectContextId, controller.signal).then(
      (listed) => {
        if (
          !controller.signal.aborted &&
          requestGeneration === suggestionGeneration.current
        )
          setSuggestions({ value: listed, failure: null })
      },
      (error: unknown) => {
        if (
          !controller.signal.aborted &&
          requestGeneration === suggestionGeneration.current
        )
          setSuggestions({
            value: null,
            failure: failureText(
              error,
              'Batch Schema Suggestions could not be read.',
            ),
          })
      },
    ).finally(() => {
      pendingRefreshes.current -= 1
    })
    return () => controller.abort()
  }, [projectContextId, reload])
  useEffect(() => {
    const activeId = suggestion.context.suggestion?.batchSchemaSuggestionId
    if (!activeId) return
    const refreshed = suggestions.value?.find(
      (candidate) => candidate.batchSchemaSuggestionId === activeId,
    )
    if (refreshed)
      sendSuggestion({ type: 'suggestion.updated', suggestion: refreshed })
  }, [sendSuggestion, suggestion.context.suggestion?.batchSchemaSuggestionId, suggestions.value])

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

  // The chosen Extraction Schema’s fields, so the researcher sees what will be
  // extracted before running. The preview renders only while it still matches
  // the selection; a failed read just leaves it hidden.
  useEffect(() => {
    const schema = schemas.value?.find(
      (item) => item.currentRevision?.schemaRevisionId === schemaRevisionId,
    )
    if (!schema) return
    const controller = new AbortController()
    getSchemaRevision(
      projectContextId,
      schema.extractionSchemaId,
      schemaRevisionId,
      controller.signal,
    ).then(
      (revision) => {
        if (!controller.signal.aborted) setChosenSchema(revision)
      },
      () => {},
    )
    return () => controller.abort()
  }, [projectContextId, schemaRevisionId, schemas.value])

  useEffect(() => {
    const active = [
      ...(batches.value ?? []),
      ...(suggestions.value ?? []),
    ].some(
      (operation) =>
      operation.executionStatus === 'QUEUED' ||
      operation.executionStatus === 'RUNNING',
    )
    if (!active) return
    const refresh = () => {
      if (pendingRefreshes.current === 0)
        setReload((value) => value + 1)
    }
    const interval = window.setInterval(refresh, 2_000)
    return () => window.clearInterval(interval)
  }, [batches.value, suggestions.value])

  // Reports a Batch Extraction the moment it finishes running. Skipped
  // whenever its own review grid is already open — the grid's header already
  // shows this live, so a popup on top would just be noise.
  useEffect(() => {
    for (const batch of batches.value ?? []) {
      const previous = previousExecutionStatus.current.get(batch.batchExtractionId)
      const current = batch.executionStatus
      previousExecutionStatus.current.set(batch.batchExtractionId, current)
      const wasRunning = previous === 'RUNNING' || previous === 'QUEUED'
      // A batch never fails as a whole: it completes once every member has settled.
      const nowTerminal = current === 'COMPLETED'
      const gridAlreadyOpenForThisBatch =
        screen === 'grid' && openBatchExtractionId === batch.batchExtractionId
      if (wasRunning && nowTerminal && !gridAlreadyOpenForThisBatch)
        setFinishedBatchReport(batch)
    }
  }, [batches.value, screen, openBatchExtractionId])

  useEffect(() => {
    const refresh = () => {
      if (pendingRefreshes.current === 0)
        setReload((value) => value + 1)
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

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
      ? `Schema Revision ${openBatch.schemaRevisionNumber} is no longer the current revision of ${openBatch.extractionSchemaName}, so this Batch Extraction cannot run again. Start a New Batch Extraction with the schema instead.`
      : currentPinnedBatchSchema &&
          currentPinnedBatchSchema.recordScope !== recordScopeOf(openBatch.strategy)
        ? `Schema Revision ${openBatch.schemaRevisionNumber} ${currentPinnedBatchSchema.recordScope === null
          ? 'declares neither Article nor Catalog'
          : `is saved as ${STRATEGY_NAME[strategyOf(currentPinnedBatchSchema.recordScope)]}`}, so this Batch Extraction cannot run again as ${STRATEGY_NAME[openBatch.strategy]}. Start a New Batch Extraction with the schema and choose Article or Catalog there.`
        : null
  // The Schema Revision the open Batch Extraction pinned, so its export offers
  // the schema-led choices of the schema that actually produced the results.
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
              'The pinned Schema Revision could not be read.',
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

  /** One spreadsheet over every Extraction Result this batch has produced. */
  const exportOpenBatch = async (
    format: ExportFormat,
    choices: ExportChoices,
  ) => {
    // Never project one batch's results through another's pinned schema.
    if (
      !openBatch ||
      currentPinnedBatchSchema?.schemaRevisionId !== openBatch.schemaRevisionId
    )
      return
    const snapshot = await getBatchExtractionResults(
      projectContextId,
      openBatch.batchExtractionId,
    )
    if (snapshot.results.length === 0)
      throw new Error(
        'This Batch Extraction has produced no Extraction Result to export.',
      )
    const partial = snapshot.successfulResults < snapshot.totalMembers
    const contested = snapshot.results.reduce((count, result) => count + (result.contested?.length ?? 0), 0)
    setExportCoverage({
      batchExtractionId: openBatch.batchExtractionId,
      message: `Includes ${snapshot.successfulResults} of ${snapshot.totalMembers} Source Documents; ${snapshot.pending} pending, ${snapshot.failed} failed, ${snapshot.cancelled} cancelled.${
        contested === 0 ? ''
          : format === 'csv' ? ` ${contestedNotice(contested)}`
            : ` ${contested} contested ${contested === 1 ? 'field is' : 'fields are'} left empty and listed on the Review notes sheet.`}`,
    })
    await exportBatchExtractionResults(
      snapshot.results.map((result) => ({
        sourceDocumentId: result.sourceDocumentId,
        sourceDocumentName: documentName(result.sourceDocumentId),
        result: result.result,
        ...(result.contested?.length ? {
          contested: result.contested.map(({ resultPath: [, record, ...path], candidates }) => ({
            record: Number(record), path, candidates,
          })),
        } : {}),
      })),
      {
        format,
        filename: `${openBatch.extractionSchemaName} revision ${openBatch.schemaRevisionNumber} batch ${openBatch.batchExtractionId.slice(0, 8)}${partial ? ' partial' : ''}`,
        batchExtractionId: openBatch.batchExtractionId,
        schemaNodes: currentPinnedBatchSchema.schemaNodes,
        choices,
      },
    )
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
  const acceptOpenedBatch = useCallback(
    (opened: Awaited<ReturnType<typeof openBatchExtraction>>) => {
      recordBatch(opened.batchExtraction)
      setSelected(new Set())
      setRunNotice(
        opened.disposition === 'replayed'
          ? 'This selection had already been run. Its existing Batch Extraction is open below; choose Run again to run the same selection fresh.'
          : null,
      )
      if (opened.disposition === 'replayed') {
        setPreparing(false)
        onNavigate({
          kind: 'project',
          projectContextId,
          tab: 'extractions',
          batchExtractionId: opened.batchExtraction.batchExtractionId,
        })
      } else showHistory()
    },
    [onNavigate, projectContextId, recordBatch, showHistory],
  )

  const suggestFields = () => {
    if (selected.size === 0 || overSelectionLimit) return
    sendSuggestion({
      type: 'selection.changed',
      sourceDocumentIds: [...selected],
      suggestion: null,
    })
    sendSuggestion({ type: 'suggestion.requested' })
  }

  const regenerateSuggestedFields = () => {
    if (!activeSuggestion || !suggestionHasMembers || selected.size === 0 || overSelectionLimit) return
    setRunFailure(null)
    setRunNotice(null)
    sendSuggestion({ type: 'suggestion.retry' })
  }

  const updateSuggestedDefinition = (
    update: (definition: SchemaDefinition) => SchemaDefinition,
  ) => {
    if (!suggestion.context.draft) return
    sendSuggestion({
      type: 'proposal.changed',
      definition: update(suggestion.context.draft),
    })
  }

  const openExistingSchemaBatch = async () => {
    if (opening.current || saved.state.status !== 'ready') return
    const savedState = saved.state
    opening.current = true
    setOpeningBatch(true)
    setRunFailure(null)
    setMethodConflict(null)
    setRunNotice(null)
    try {
      const savedRevision = await savedSchemaController?.flush()
      // The saved revision's own scope decides what runs; admission refuses any other.
      const recordScope = savedRevision ? savedRevision.recordScope : chosenRecordScope
      if (recordScope === null)
        throw new Error('Choose Article or Catalog before running.')
      const strategy = strategyOf(recordScope)
      const request = {
        projectContextId,
        schemaRevisionId: savedRevision?.schemaRevisionId ?? schemaRevisionId,
        strategy,
        sourceDocumentIds: [...selected],
        method: savedMethodFor(savedState, strategy, null),
      }
      acceptOpenedBatch(await openBatchExtraction(request))
    } catch (error) {
      if (methodChanged(error)) setMethodConflict(error.message)
      else setRunFailure(failureText(error, 'The Batch Extraction could not be opened.'))
    } finally {
      opening.current = false
      setOpeningBatch(false)
    }
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
    opening.current = true
    setOpeningBatch(true)
    setRunFailure(null)
    setMethodConflict(null)
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
      setSelected(new Set())
      openMembers(opened.batchExtraction)
    } catch (error) {
      if (methodChanged(error)) setMethodConflict(error.message)
      else setRunFailure(failureText(error, 'The Batch Extraction could not be run again.'))
    } finally {
      opening.current = false
      setOpeningBatch(false)
    }
  }

  const openNewBatch = () => {
    setRunFailure(null)
    setMethodConflict(null)
    setRunNotice(null)
    if (!canRun || saved.state.status !== 'ready') return
    if (schemaRevisionId === SUGGEST_SCHEMA) {
      sendSuggestion({
        type: 'run.requested',
        strategy: batchStrategy,
        method: savedMethodFor(saved.state, batchStrategy, null),
      })
      return
    }
    void openExistingSchemaBatch()
  }

  const openMembers = (batch: BatchExtraction) => {
    setPreparing(false)
    onNavigate({
      kind: 'project',
      projectContextId,
      tab: 'extractions',
      batchExtractionId: batch.batchExtractionId,
    })
  }

  const openGridReview = (batch: BatchExtraction) => {
    onNavigate({
      kind: 'project',
      projectContextId,
      tab: 'extractions',
      batchExtractionId: batch.batchExtractionId,
      view: 'grid',
    })
  }

  const openBatchHasSuccessfulResult =
    openBatch?.members.some((member) => member.latestExtraction !== null) ??
    false
  const filtered = sourceDocuments.filter((document) =>
    document.name
      .toLocaleLowerCase()
      .includes(filter.trim().toLocaleLowerCase()),
  )
  const allSourceDocumentsSelected =
    sourceDocuments.length > 0 &&
    sourceDocuments.every((document) =>
      selected.has(document.sourceDocumentId),
    )
  const overSelectionLimit = selected.size > BATCH_EXTRACTION_SELECTION_LIMIT
  const suggestedFields = suggestionProposal
  const selectedSchema = schemas.value?.find(
    (schema) => schema.currentRevision?.schemaRevisionId === schemaRevisionId,
  )
  // An existing schema's strategy is its saved Article/Catalog scope (the choice its editor saves next, once mounted);
  // a suggested schema's is chosen here and declared by the revision the suggestion saves.
  const chosenSchemaShown =
    schemaRevisionId !== SUGGEST_SCHEMA && chosenSchema?.schemaRevisionId === schemaRevisionId
  // Only the chosen schema's own editor speaks for it (a replaced editor may still be registered for a render).
  const chosenEditor =
    savedSchemaSnap?.extractionSchemaId === chosenSchema?.extractionSchemaId ? savedSchemaSnap : null
  const chosenRecordScope = chosenSchemaShown
    ? chosenEditor ? chosenEditor.recordScope : chosenSchema.recordScope
    : null
  const selectedStrategy: ExtractionStrategy | null =
    schemaRevisionId === SUGGEST_SCHEMA
      ? batchStrategy
      : chosenRecordScope === null
        ? null
        : strategyOf(chosenRecordScope)
  const strategyUnchosen = chosenSchemaShown && chosenRecordScope === null
  const suggestingFields =
    suggestion.matches('creating') ||
    suggestion.matches('suggesting') ||
    suggestion.matches('retrying')
  const preparingSuggestedBatch =
    suggestion.matches('running')
  const openingAnyBatch = openingBatch || preparingSuggestedBatch
  const validSelection =
    selected.size > 0 && selected.size <= BATCH_EXTRACTION_SELECTION_LIMIT
  const canRun =
    validSelection &&
    !openingAnyBatch &&
    saved.state.status === 'ready' &&
    (schemaRevisionId === SUGGEST_SCHEMA
      ? confirmedSuggestion === null &&
        // Pins cascade with their Source Documents: a draft whose members were all deleted has nothing to run on.
        suggestionHasMembers &&
        suggestedFields?.status === 'ready' &&
        suggestion.can({
          type: 'run.requested',
          strategy: batchStrategy,
          method: savedMethodFor(saved.state, batchStrategy, null),
        }) &&
        !suggestionHasPendingLocalEdit &&
        runnableSuggestionDefinition(suggestion.context.draft)
      : schemaRevisionId.length > 0 &&
        selectedStrategy !== null &&
        // Opening waits for the editor's save; a failed or conflicting one blocks it until the editor recovers.
        chosenEditor?.save?.status !== 'error' &&
        chosenEditor?.save?.status !== 'conflict')
  const toggleAllSourceDocuments = () => {
    if (schemaRevisionId === SUGGEST_SCHEMA) clearSuggestedFields()
    setSelected(
      allSourceDocumentsSelected ? new Set() : new Set(sourceDocumentIds),
    )
  }
  // Both screens depend on the list read: a routed Batch Extraction is reached
  // before it has been read, and until then the batch is unknown, not missing.
  const batchesUnread = reading(batches) ? (
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
  ) : null
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
      className="flex flex-col pt-1"
      tabIndex={0}
    >
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
              disabled={openingAnyBatch}
              onClick={() => {
                clearSuggestedFields()
                showHistory()
              }}
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
            <p className="truncate text-sm font-semibold text-ink">{heading}</p>
          )}
        </div>
        {/* On `prepare` this button only reopens the screen already shown. */}
        {screen !== 'prepare' && (
          <Button
            variant="primary"
            size="md"
            disabled={openingAnyBatch}
            onClick={() => {
              setSelected(new Set(sourceDocumentIds))
              setPreparing(true)
            }}
          >
            {openingAnyBatch ? (
              'Opening Batch Extraction…'
            ) : (
              <>
                <PlusIcon />
                New Batch Extraction
              </>
            )}
          </Button>
        )}
      </div>
      {runFailure && (
        <p className="mb-3 shrink-0 text-[11px] leading-snug text-danger" role="alert">
          {runFailure}
        </p>
      )}
      {runNotice && (
        <p className="mb-3 shrink-0 text-[11px] leading-snug text-ink-muted" role="status">
          {runNotice}
        </p>
      )}

      <div
        className={
          screen === 'grid' ? 'flex flex-col' : 'min-h-[430px]'
        }
      >
        {screen === 'history' ? (
          batchesUnread ? (
            batchesUnread
          ) : (
            <BatchExtractionHistory batches={batchList} onOpen={openMembers} />
          )
        ) : screen === 'prepare' ? (
          <>
            <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-[11px] font-semibold text-ink-muted">
                Extraction Schema
                <select
                  className={`${control} mt-1 block w-full font-normal`}
                  value={schemaRevisionId}
                  disabled={schemas.value === null || openingAnyBatch}
                  onChange={(event) => {
                    const nextRevisionId = event.target.value
                    setSchemaRevisionId(nextRevisionId)
                    if (nextRevisionId !== SUGGEST_SCHEMA) {
                      clearSuggestedFields()
                      return
                    }
                    const matching = (suggestions.value ?? []).find(
                      (suggestion) =>
                        suggestion.sources.length === selected.size &&
                        suggestion.sources.every((source) =>
                          selected.has(source.sourceDocumentId),
                        ),
                    )
                    sendSuggestion({
                      type: 'selection.changed',
                      sourceDocumentIds: [...selected],
                      suggestion: matching ?? null,
                    })
                  }}
                >
                  {schemas.value ? (
                    <>
                      <option value="" disabled>
                        Select an Extraction Schema
                      </option>
                      {schemas.value.flatMap((schema) =>
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
                      )}
                      <option value={SUGGEST_SCHEMA}>
                        Suggest fields from selected sources
                      </option>
                    </>
                  ) : (
                    <option value="">
                      {schemas.failure
                        ? 'Schemas unavailable'
                        : 'Loading schemas…'}
                    </option>
                  )}
                </select>
              </label>
              <label className="text-[11px] font-semibold text-ink-muted" title={STRATEGY_HELP}>
                Extraction Strategy
                <select
                  className={`${control} mt-1 block w-full font-normal`}
                  aria-label="Batch extraction strategy"
                  aria-describedby={strategyUnchosen ? 'batch-extraction-strategy-help' : undefined}
                  value={selectedStrategy ?? ''}
                  disabled={
                    openingAnyBatch ||
                    (schemaRevisionId !== SUGGEST_SCHEMA && (!chosenSchemaShown || savedSchemaController === null))
                  }
                  onChange={(event) => {
                    const strategy = event.target.value as ExtractionStrategy
                    if (schemaRevisionId === SUGGEST_SCHEMA) setBatchStrategy(strategy)
                    // A scope change is a schema change: the editor appends a revision with it.
                    else savedSchemaController?.setRecordScope(recordScopeOf(strategy))
                  }}
                >
                  {selectedStrategy === null && (
                    <option value="" disabled>Choose…</option>
                  )}
                  <option value="ARTICLE">Article</option>
                  <option value="CATALOG">Catalog</option>
                </select>
                {strategyUnchosen && (
                  <span id="batch-extraction-strategy-help" className="mt-1 block font-normal">
                    {STRATEGY_HELP}
                  </span>
                )}
              </label>
            </div>
            <div className="mb-3">
              {selectedStrategy !== null && (
                <SavedMethodSummary variant="panel" saved={saved.state} conflict={methodConflict}
                  method={saved.state.status === 'ready' ? savedMethodFor(saved.state, selectedStrategy, null) : null}
                  onRefresh={() => { setMethodConflict(null); void saved.refresh() }} />
              )}
            </div>
            {schemas.failure && (
              <p className="mb-3 text-[11px] text-danger" role="alert">
                {schemas.failure}
              </p>
            )}
            {chosenSchema?.schemaRevisionId === schemaRevisionId && (
              <SavedSchemaEditor
                key={chosenSchema.schemaRevisionId}
                projectContextId={projectContextId}
                chosenSchema={chosenSchema}
                sourceDocumentName={
                  selectedSchema
                    ? `${selectedSchema.name} · Schema Revision ${chosenSchema.revisionNumber}`
                    : `Schema Revision ${chosenSchema.revisionNumber}`
                }
                registerController={setSavedSchemaController}
              />
            )}
            {schemaRevisionId === SUGGEST_SCHEMA && (
              <section
                className="mb-5 space-y-3"
                aria-label="Suggested common fields"
              >
                {suggestion.matches('idle') && (
                  <Button
                    size="sm"
                    disabled={selected.size === 0 || overSelectionLimit}
                    onClick={suggestFields}
                  >
                    Suggest common fields
                  </Button>
                )}
                {suggestingFields && (
                  <p className="text-xs text-ink-muted" aria-busy="true">
                    Suggesting common fields…
                  </p>
                )}
                {(activeSuggestion?.failure || (suggestion.context.error && !suggestionMethodConflict)) && (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[11px] text-danger" role="alert">
                        {activeSuggestion?.failure
                          ? suggestionFailureText(activeSuggestion.failure)
                          : suggestion.context.error}
                      </p>
                      {(suggestion.matches('failed') ||
                        (activeSuggestion?.executionStatus === 'FAILED' &&
                          suggestion.can({ type: 'suggestion.retry' }))) && (
                        <Button
                          size="sm"
                          disabled={
                            selected.size === 0 ||
                            overSelectionLimit ||
                            !suggestionHasMembers
                          }
                          onClick={() =>
                            sendSuggestion({ type: 'suggestion.retry' })
                          }
                        >
                          Try again
                        </Button>
                      )}
                    </div>
                  </div>
                )}
                {draftConflict && (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[11px] text-danger" role="alert">
                      This draft changed in another tab. Reload the saved draft
                      before continuing.
                    </p>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setReload((value) => value + 1)
                      }}
                    >
                      Reload saved draft
                    </Button>
                  </div>
                )}
                {excerptNotices.map((notice) => (
                  <p key={notice.sourceDocumentId} className="text-[11px] text-ink-muted" role="note">
                    {notice.text}
                  </p>
                ))}
                {suggestedFields?.status === 'heterogeneous' && (
                  <p className="text-xs text-ink-muted">
                    No reliable common field set was found. Choose an existing
                    Extraction Schema or change the selection.
                  </p>
                )}
                {suggestedFields?.status === 'ready' && (
                  <div
                    className="h-[32rem] overflow-hidden rounded-md border border-line bg-surface"
                    aria-busy={preparingSuggestedBatch || suggestingFields}
                    inert={preparingSuggestedBatch ? true : undefined}
                  >
                    <SuggestedSchemaEditor
                      key={suggestedFields.selectionKey}
                      proposal={suggestedFields}
                      proposalVersion={{
                        draftVersion: activeSuggestion?.draftVersion ?? 0,
                        attempt: activeSuggestion?.attempt ?? 1,
                      }}
                      sourceDocumentName={`${selected.size} selected Source Document${selected.size === 1 ? '' : 's'}`}
                      // The retained draft is read-only while an attempt that would replace it runs.
                      readOnly={confirmedSuggestion !== null || suggestingFields}
                      showRegenerate={confirmedSuggestion === null && suggestionHasMembers}
                      onGenerateInstructions={regenerateSuggestedFields}
                      onProposalEdit={updateSuggestedDefinition}
                      onPendingLocalEditChange={
                        setSuggestionHasPendingLocalEdit
                      }
                    />
                  </div>
                )}
              </section>
            )}
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
              <div>
                <h3 className="text-xs font-bold text-ink">Source Documents</h3>
                <p className="text-[11px] text-ink-faint">
                  {selected.size} selected
                </p>
              </div>
              <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto sm:flex-nowrap">
                <Button
                  variant="secondary"
                  disabled={sourceDocuments.length === 0 || openingAnyBatch}
                  onClick={toggleAllSourceDocuments}
                >
                  {allSourceDocumentsSelected ? 'Unselect all' : 'Select all'}
                </Button>
                <input
                  className={`${control} w-full sm:w-48`}
                  type="search"
                  aria-label="Filter Source Documents"
                  placeholder="Filter Source Documents"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </div>
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
                        disabled={openingAnyBatch}
                        onChange={() => {
                          if (schemaRevisionId === SUGGEST_SCHEMA)
                            clearSuggestedFields()
                          setSelected((current) => {
                            const next = new Set(current)
                            if (next.has(document.sourceDocumentId))
                              next.delete(document.sourceDocumentId)
                            else next.add(document.sourceDocumentId)
                            return next
                          })
                        }}
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
                disabled={!canRun}
                onClick={openNewBatch}
              >
                {openingAnyBatch ? 'Opening…' : 'Run'} {selected.size} Source
                Document
                {selected.size === 1 ? '' : 's'}
              </Button>
            </div>
          </>
        ) : batchesUnread ? (
          batchesUnread
        ) : !openBatch ? (
          <p className="py-6 text-center text-xs text-ink-muted">
            That Batch Extraction is no longer listed.
          </p>
        ) : screen === 'grid' ? (
          <BatchExtractionReviewGrid
            batch={openBatch}
            schemaNodes={currentPinnedBatchSchema?.schemaNodes ?? null}
            documentName={documentName}
            onBack={() => openMembers(openBatch)}
            onOpenMember={(sourceDocumentId, extractionId) =>
              onNavigate({
                kind: 'document',
                projectContextId,
                sourceDocumentId,
                extractionId,
                fromBatchExtractionId: openBatch.batchExtractionId,
              })
            }
            onMemberSaved={() => setReload((value) => value + 1)}
          />
        ) : (
          <BatchExtractionMembers
            batch={openBatch}
            pinnedSchema={
              currentPinnedBatchSchema
                ? {
                    recordDescription:
                      currentPinnedBatchSchema.recordDescription,
                    schemaNodes: currentPinnedBatchSchema.schemaNodes,
                  }
                : null
            }
            pinnedSchemaFailure={currentPinnedBatchSchemaFailure}
            hasSuccessfulResult={openBatchHasSuccessfulResult}
            coverageMessage={
              exportCoverage?.batchExtractionId === openBatch.batchExtractionId
                ? exportCoverage.message
                : null
            }
            opening={openingAnyBatch}
            canRunAgain={saved.state.status === 'ready'}
            runAgainRefusal={runAgainRefusal}
            runAgainMethod={
              <SavedMethodSummary variant="panel" saved={saved.state} conflict={methodConflict}
                method={saved.state.status === 'ready' ? savedMethodFor(saved.state, openBatch.strategy, null) : null}
                onRefresh={() => { setMethodConflict(null); void saved.refresh() }} />
            }
            documentName={documentName}
            onExport={exportOpenBatch}
            onRetrySchema={() =>
              setPinnedBatchSchemaReload((value) => value + 1)
            }
            onRunAgain={() => void runOpenBatchAgain(openBatch)}
            onOpenGridReview={() => openGridReview(openBatch)}
            onOpenMember={(sourceDocumentId, extractionId) =>
              onNavigate({
                kind: 'document',
                projectContextId,
                sourceDocumentId,
                extractionId,
              })
            }
          />
        )}
      </div>
      {finishedBatchReport && (
        <BatchExtractionFinishedDialog
          key={finishedBatchReport.batchExtractionId}
          batch={finishedBatchReport}
          projectContextId={projectContextId}
          documentName={documentName}
          onReviewNow={() => {
            openGridReview(finishedBatchReport)
            setFinishedBatchReport(null)
          }}
          onDismiss={() => setFinishedBatchReport(null)}
        />
      )}
    </div>
  )
}

/**
 * The chosen Extraction Schema's fields before running a Batch Extraction.
 * Edits append revisions immediately (debounce 0): the run that follows must
 * bind to what the researcher just saw.
 */
function SavedSchemaEditor({
  projectContextId,
  chosenSchema,
  sourceDocumentName,
  registerController,
}: {
  projectContextId: string
  chosenSchema: SchemaRevision
  sourceDocumentName: string
  registerController: (controller: SchemaEditorController | null) => void
}) {
  const schema = useDurableCurrentSchemaRevision({
    projectContextId,
    extractionSchema: chosenSchema,
    debounceMs: 0,
  })
  useEffect(() => {
    registerController(schema)
    return () => registerController(null)
  }, [schema, registerController])
  const snap = useSyncExternalStore(schema.subscribe, schema.snapshot)
  const failure =
    snap.save?.status === 'error'
      ? snap.save.error?.message ?? 'The schema could not be saved.'
      : null
  // A flush retries the failed save with the latest fields and scope; a new failure shows here again.
  const retrySave = () => void schema.flush().catch(() => undefined)
  // Clear keeps the record description and empties the fields — the same
  // empty-draft-saved-immediately semantics this screen always had.
  async function clearDraft() {
    const result = schema.clearDraft('Cleared fields')
    if (!result.ok) return
    await schema.flush()
  }
  return (
    <>
      <section
        className="mb-5 h-[32rem] overflow-hidden rounded-md border border-line bg-surface"
        aria-label="Extraction Schema fields"
      >
        <SchemaPanel
          schema={schema}
          onClearDraft={clearDraft}
          sourceDocumentName={sourceDocumentName}
          showRegenerate={false}
        />
      </section>
      {failure && (
        <div className="-mt-3 mb-5 flex flex-wrap items-center gap-2">
          <p className="text-[11px] text-danger" role="alert">
            {failure}
          </p>
          <Button onClick={retrySave}>
            Retry save
          </Button>
        </div>
      )}
    </>
  )
}

/**
 * A Batch Schema Suggestion's editable proposal. Nothing here is durable:
 * every committed edit forwards into the caller-owned suggestion draft
 * machinery, and chat-driven edits stay unavailable exactly as before.
 */
function SuggestedSchemaEditor({
  proposal,
  proposalVersion,
  sourceDocumentName,
  readOnly,
  showRegenerate,
  onGenerateInstructions,
  onProposalEdit,
  onPendingLocalEditChange,
}: {
  proposal: SchemaDefinition
  proposalVersion: SuggestionDraftVersion
  sourceDocumentName: string
  readOnly: boolean
  showRegenerate: boolean
  onGenerateInstructions?: (instruction: string) => void
  onProposalEdit: (
    update: (definition: SchemaDefinition) => SchemaDefinition,
  ) => void
  onPendingLocalEditChange(pending: boolean): void
}) {
  // The parent's suggestion machinery changes identity every render; the
  // latest callback is read from the ref inside the persistence's onEdit.
  const onProposalEditRef = useRef(onProposalEdit)
  useEffect(() => {
    onProposalEditRef.current = onProposalEdit
  })
  const proposalVersionRef = useRef(proposalVersion)
  const schema = useSchemaEditorController(() => {
    const persistence = localSchemaPersistence({
      onEdit: (definition) => onProposalEditRef.current(() => definition),
    })
    return createSchemaEditorController(persistence, {
      initialDraft: proposal,
    })
  })
  useEffect(() => {
    const previous = proposalVersionRef.current
    if (
      previous.draftVersion === proposalVersion.draftVersion &&
      previous.attempt === proposalVersion.attempt
    )
      return
    proposalVersionRef.current = proposalVersion
    const current = schema.snapshot().draft
    if (current && sameSchemaDefinition(current, proposal)) return
    schema.adoptDraft(proposal)
  }, [proposal, proposalVersion, schema])
  function clearDraft() {
    schema.clearDraft('')
  }
  return (
    <SchemaPanel
      schema={schema}
      onGenerateInstructions={onGenerateInstructions}
      onClearDraft={clearDraft}
      sourceDocumentName={sourceDocumentName}
      readOnly={readOnly}
      showRegenerate={showRegenerate}
      onPendingLocalEditChange={onPendingLocalEditChange}
    />
  )
}
