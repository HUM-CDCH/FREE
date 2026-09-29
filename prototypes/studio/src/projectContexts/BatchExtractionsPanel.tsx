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
} from '../schemaRevisions'
import type { SchemaRevision } from '../../shared/schemaRevision.contract'
import { Button, GuidedNextStep } from '../ui'
import {
  BATCH_EXTRACTION_SELECTION_LIMIT,
  PILOT_BATCH_SELECTION_LIMIT,
  type BatchExtraction,
} from '../../shared/batchExtraction.contract'
import {
  parseBatchSuggestionDefinition,
  type SchemaDefinition,
} from 'extraction/schema'
import type { BatchSchemaSuggestion } from '../../shared/batchSchemaSuggestion.contract'
import type { ExtractionStrategy } from '../../shared/extraction.contract'
import PlusIcon from '../PlusIcon'
import SchemaPanel from '../SchemaPanel'
import {
  createSchemaEditorController,
  localSchemaPersistence,
} from '../currentSchemaRevision'
import { sameSchemaDefinition } from '../schemaDefinitionEquality'
import {
  useDurableCurrentSchemaRevision,
  useSchemaEditorController,
} from '../useCurrentSchemaRevision'
import type { AcknowledgedSchemaRevision } from '../schemaSaveCoordinator'
import {
  BatchExtractionRequestError,
  getBatchExtractionResults,
  listBatchExtractions,
  listBatchSchemaSuggestions,
  openBatchExtraction,
} from './batchExtractions'
import { stabiliseSchemaRevision } from './schemaGovernance'
import { useBatchSchemaSuggestion } from './useBatchSchemaSuggestion'
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

export type SuggestionDraftVersion = Pick<
  BatchSchemaSuggestion,
  'draftVersion' | 'finishedAt'
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

/** The immediately preceding pilot round under the same Schema Revision as
 *  `current` (design.md D2: a pilot round is a Batch Extraction at or under
 *  `PILOT_BATCH_SELECTION_LIMIT` members) — the comparison point for the
 *  soft "ready to stabilise" signal. */
function priorPilotRound(
  batches: readonly BatchExtraction[],
  current: BatchExtraction,
): BatchExtraction | null {
  const candidates = batches.filter(
    (batch) =>
      batch.batchExtractionId !== current.batchExtractionId &&
      batch.schemaRevisionId === current.schemaRevisionId &&
      batch.members.length <= PILOT_BATCH_SELECTION_LIMIT &&
      Date.parse(batch.createdAt) < Date.parse(current.createdAt),
  )
  if (candidates.length === 0) return null
  return candidates.reduce((newest, batch) =>
    Date.parse(batch.createdAt) > Date.parse(newest.createdAt) ? batch : newest,
  )
}

/** Source Documents already reviewed under this Schema Revision in some
 *  prior Batch Extraction — what a new batch against the same revision would
 *  reuse instead of re-extracting (batch-extraction-pilot-reuse). */
function alreadyReviewedSourceDocumentIds(
  batches: readonly BatchExtraction[],
  schemaRevisionId: string,
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const batch of batches) {
    if (batch.schemaRevisionId !== schemaRevisionId) continue
    for (const member of batch.members)
      if (member.latestExtraction?.reviewedAt) ids.add(member.sourceDocumentId)
  }
  return ids
}

function runnableSuggestionDefinition(value: unknown): boolean {
  try {
    parseBatchSuggestionDefinition(value)
    return true
  } catch {
    return false
  }
}

const suggestionFailureCategories: Readonly<Record<string, string>> = {
  invalid_model_config: 'Model configuration error',
  model_operation_failed: 'Model request failed',
  invalid_model_output: 'Invalid model output',
  unexpected_failure: 'Unexpected failure',
}

export function SuggestionSourceProgress({
  suggestion,
  documentName,
}: {
  suggestion: BatchSchemaSuggestion
  documentName(sourceDocumentId: string): string
}) {
  const counts = suggestion.sources.reduce(
    (current, source) => ({
      ...current,
      [source.executionStatus]: current[source.executionStatus] + 1,
    }),
    { QUEUED: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0 },
  )
  const progress = [
    `${counts.COMPLETED} of ${suggestion.sources.length} complete`,
    counts.RUNNING ? `${counts.RUNNING} running` : null,
    counts.QUEUED ? `${counts.QUEUED} queued` : null,
    counts.FAILED ? `${counts.FAILED} failed` : null,
    suggestion.phase === 'MERGING' ? 'merging common fields' : null,
  ].filter((part): part is string => part !== null)
  return (
    <div className="space-y-2" aria-label="Source suggestion progress">
      <p className="text-[11px] text-ink-muted" role="status">
        {progress.join(' · ')}
      </p>
      <ul className="space-y-1 text-[11px]">
        {suggestion.sources.map((source) => {
          const status =
            source.executionStatus === 'COMPLETED'
              ? 'Complete'
              : source.executionStatus === 'RUNNING'
                ? 'Running'
                : source.executionStatus === 'FAILED'
                  ? 'Failed'
                  : 'Queued'
          const category = source.failure
            ? suggestionFailureCategories[source.failure.code] ??
              'Unexpected failure'
            : null
          return (
            <li
              className="flex items-baseline justify-between gap-3"
              key={source.sourceDocumentId}
            >
              <span className="min-w-0 truncate text-ink-muted">
                {documentName(source.sourceDocumentId)}
              </span>
              <span
                className={
                  source.executionStatus === 'FAILED'
                    ? 'shrink-0 font-semibold text-danger'
                    : source.executionStatus === 'COMPLETED'
                      ? 'shrink-0 font-semibold text-green'
                      : 'shrink-0 font-semibold text-ink-faint'
                }
              >
                {status}
                {category ? ` — ${category}` : ''}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
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
  const [runFailure, setRunFailure] = useState<string | null>(null)
  // Set when `runFailure` came from a known API error code (e.g.
  // `schema_not_stabilised`), so the failure area can offer a specific next
  // step instead of just the message (guided-workflow-phases).
  const [runFailureCode, setRunFailureCode] = useState<string | null>(null)
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
  const [chosenSchemaReload, setChosenSchemaReload] = useState(0)
  const [exportCoverage, setExportCoverage] = useState<{
    batchExtractionId: string
    message: string
  } | null>(null)
  // Carries a flagged field's context into the schema editor after "Edit
  // schema" is chosen from the review grid (schema-issue-flagging) — a
  // client-side hand-off, not persisted state.
  const [pendingSchemaEditDraft, setPendingSchemaEditDraft] = useState<string | null>(null)
  const [stabilisingChosenSchema, setStabilisingChosenSchema] = useState(false)
  const [stabiliseChosenSchemaError, setStabiliseChosenSchemaError] = useState<string | null>(null)
  // Guided next-step nudge (guided-pilot-extraction-workflow): fires right
  // after a Schema Revision is stabilised, from either the preparation
  // screen's own "Stabilise schema" button or the review grid's. Holds the
  // just-stabilised `schemaRevisionId` so "Run the full collection" can
  // preselect it regardless of which screen triggered it.
  const [stabiliseNudge, setStabiliseNudge] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(sourceDocumentIds),
  )
  const [filter, setFilter] = useState('')
  const opening = useRef(false)
  // The saved-schema editor registers its flush so opening a Batch Extraction
  // can wait for the chosen schema's pending save.
  const savedSchemaFlush = useRef<(() => Promise<AcknowledgedSchemaRevision | null>) | null>(null)
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
          coverage: activeSuggestion.coverage ?? [],
        }
      : activeSuggestion?.phase === 'HETEROGENEOUS'
        ? {
            status: 'heterogeneous' as const,
            selectionKey: activeSuggestion.selectionKey,
          }
        : null
  const draftConflict = suggestion.matches('conflict')

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
  }, [projectContextId, schemaRevisionId, schemas.value, chosenSchemaReload])

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
      const current = batch.executionStatus ?? 'COMPLETED'
      previousExecutionStatus.current.set(batch.batchExtractionId, current)
      const wasRunning = previous === 'RUNNING' || previous === 'QUEUED'
      const nowTerminal = current === 'COMPLETED' || current === 'FAILED'
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
    setExportCoverage({
      batchExtractionId: openBatch.batchExtractionId,
      message: `Includes ${snapshot.successfulResults} of ${snapshot.totalMembers} Source Documents; ${snapshot.pending} pending, ${snapshot.failed} failed, ${snapshot.cancelled} cancelled.`,
    })
    await exportBatchExtractionResults(
      snapshot.results.map((result) => ({
        sourceDocumentId: result.sourceDocumentId,
        sourceDocumentName: documentName(result.sourceDocumentId),
        result: result.result,
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
    if (!activeSuggestion || selected.size === 0 || overSelectionLimit) return
    setRunFailure(null)
    setRunFailureCode(null)
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
    if (opening.current) return
    opening.current = true
    setOpeningBatch(true)
    setRunFailure(null)
    setRunFailureCode(null)
    setRunNotice(null)
    try {
      const savedRevision = await savedSchemaFlush.current?.()
      const request = {
        projectContextId,
        schemaRevisionId: savedRevision?.schemaRevisionId ?? schemaRevisionId,
        strategy: batchStrategy,
        sourceDocumentIds: [...selected],
      }
      acceptOpenedBatch(await openBatchExtraction(request))
    } catch (error) {
      setRunFailure(
        failureText(error, 'The Batch Extraction could not be opened.'),
      )
      setRunFailureCode(error instanceof BatchExtractionRequestError ? error.code : null)
    } finally {
      opening.current = false
      setOpeningBatch(false)
    }
  }

  /** Stabilises the Schema Revision chosen in the preparation screen,
   *  unlocking collection-scale Batch Extraction against it
   *  (guided-workflow-phases). Requires at least one reviewed pilot
   *  Extraction — enforced server-side. */
  const stabiliseChosenSchema = async () => {
    if (!chosenSchema || stabilisingChosenSchema) return
    setStabilisingChosenSchema(true)
    setStabiliseChosenSchemaError(null)
    try {
      await stabiliseSchemaRevision({
        projectContextId,
        schemaRevisionId: chosenSchema.schemaRevisionId,
      })
      setRunFailure(null)
      setRunFailureCode(null)
      setChosenSchemaReload((value) => value + 1)
      setStabiliseNudge(chosenSchema.schemaRevisionId)
    } catch (error) {
      setStabiliseChosenSchemaError(
        failureText(error, 'This Schema Revision could not be stabilised.'),
      )
    } finally {
      setStabilisingChosenSchema(false)
    }
  }

  /**
   * Runs the open Batch Extraction's selection again as its own Batch
   * Extraction. The stored one is immutable research state, so a rerun is a new
   * Batch Extraction over the same Source Documents rather than an overwrite.
   */
  const runOpenBatchAgain = async (batch: BatchExtraction) => {
    if (opening.current) return
    opening.current = true
    setOpeningBatch(true)
    setRunFailure(null)
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
      })
      recordBatch(opened.batchExtraction)
      setSelected(new Set())
      openMembers(opened.batchExtraction)
    } catch (error) {
      setRunFailureCode(error instanceof BatchExtractionRequestError ? error.code : null)
      setRunFailure(
        failureText(error, 'The Batch Extraction could not be run again.'),
      )
    } finally {
      opening.current = false
      setOpeningBatch(false)
    }
  }

  /** "Pilot Extraction" entry point: opens the preparation screen with a
   *  small (2-3) Source Document selection pre-picked, so a researcher can
   *  start piloting in one click — still free to change it before running
   *  (guided-pilot-extraction-workflow). The Extraction Schemas list isn't
   *  loaded yet at this point (it only fetches once `screen === 'prepare'`),
   *  so the schema field is left to the existing "pick the first schema
   *  with a current revision" auto-select effect that already runs once
   *  that happens, rather than duplicating its lookup here against stale
   *  (empty) data. */
  const beginPilotExtraction = () => {
    setSelected(new Set(sourceDocumentIds.slice(0, Math.min(3, sourceDocumentIds.length))))
    setPreparing(true)
  }

  const openNewBatch = () => {
    setRunFailure(null)
    setRunFailureCode(null)
    setRunNotice(null)
    if (!canRun) return
    if (schemaRevisionId === SUGGEST_SCHEMA) {
      sendSuggestion({ type: 'run.requested', strategy: batchStrategy })
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

  /**
   * "Edit schema" from a flagged field in the review grid: jumps to the
   * preparation screen on the same Schema Revision and the same pilot
   * documents, with the flag's context seeded into the schema chat draft
   * (schema-issue-flagging). Committing a new revision there and running
   * again re-extracts the same documents, satisfying "does not require the
   * researcher to re-select pilot documents" without bespoke plumbing.
   */
  const editSchemaFieldFromGrid = (
    batch: BatchExtraction,
    context: { fieldPath: string; fieldLabel: string; note: string | null },
  ) => {
    setSelected(new Set(batch.members.map((member) => member.sourceDocumentId)))
    setSchemaRevisionId(batch.schemaRevisionId)
    setPendingSchemaEditDraft(
      `Fix the "${context.fieldLabel}" field${context.note ? `: ${context.note}` : '.'}`,
    )
    setRunFailure(null)
    setRunFailureCode(null)
    setPreparing(true)
  }

  const openBatchHasSuccessfulResult =
    openBatch?.members.some(
      (member) => member.latestExtraction?.outcome === 'SUCCEEDED',
    ) ?? false
  const priorRoundBatch = openBatch ? priorPilotRound(batchList, openBatch) : null
  const alreadyReviewed =
    schemaRevisionId && schemaRevisionId !== SUGGEST_SCHEMA
      ? alreadyReviewedSourceDocumentIds(batchList, schemaRevisionId)
      : new Set<string>()
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
  const suggestingFields =
    suggestion.matches('creating') ||
    suggestion.matches('suggesting') ||
    suggestion.matches('retrying')
  const preparingSuggestedBatch =
    suggestion.matches('running')
  const openingAnyBatch = openingBatch || preparingSuggestedBatch
  // Whether there's an approved schema to pilot isn't knowable here — the
  // Extraction Schemas list only loads once inside the `prepare` screen
  // (see `beginPilotExtraction`'s note) — so this only guards against the
  // obviously-empty case; an unapproved-schema state is handled the same
  // way it already is for "New Batch Extraction".
  const canPilot = !openingAnyBatch && sourceDocumentIds.length > 0
  const validSelection =
    selected.size > 0 && selected.size <= BATCH_EXTRACTION_SELECTION_LIMIT
  // Mirrors the server's size-based stabilise gate (guided-workflow-phases):
  // a pilot-sized selection is always runnable, but a collection-scale one
  // needs the chosen Schema Revision to already be stabilised — checked
  // client-side too so Run disables proactively instead of only failing
  // after a round trip. Not applied to the schema-suggestion flow, which
  // has no existing Schema Revision to check yet.
  const collectionScaleNeedsStabilisedSchema =
    schemaRevisionId !== SUGGEST_SCHEMA &&
    selected.size > PILOT_BATCH_SELECTION_LIMIT &&
    !(chosenSchema?.schemaRevisionId === schemaRevisionId && chosenSchema.stabilisedAt)
  const canRun =
    validSelection &&
    !openingAnyBatch &&
    !collectionScaleNeedsStabilisedSchema &&
    (schemaRevisionId === SUGGEST_SCHEMA
      ? confirmedSuggestion === null &&
        suggestedFields?.status === 'ready' &&
        suggestion.can({ type: 'run.requested', strategy: batchStrategy }) &&
        !suggestionHasPendingLocalEdit &&
        runnableSuggestionDefinition(suggestion.context.draft)
      : schemaRevisionId.length > 0)
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
        {/* On `prepare` these only reopen the screen already shown. */}
        {screen !== 'prepare' && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="md"
              disabled={!canPilot}
              title={canPilot ? undefined : 'Add Source Documents on the Sources tab first.'}
              onClick={beginPilotExtraction}
            >
              <PlusIcon />
              Pilot Extraction
            </Button>
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
          </div>
        )}
      </div>
      {runFailure && (
        <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
          <p className="text-[11px] leading-snug text-danger" role="alert">
            {runFailure}
          </p>
          {runFailureCode === 'schema_not_stabilised' && (
            <Button
              size="sm"
              variant="secondary"
              disabled={stabilisingChosenSchema}
              onClick={() => void stabiliseChosenSchema()}
            >
              {stabilisingChosenSchema ? 'Stabilising…' : 'Stabilise schema'}
            </Button>
          )}
        </div>
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
              <label className="text-[11px] font-semibold text-ink-muted">
                Extraction Strategy
                <select
                  className={`${control} mt-1 block w-full font-normal`}
                  aria-label="Batch extraction strategy"
                  value={batchStrategy}
                  disabled={openingAnyBatch}
                  onChange={(event) =>
                    setBatchStrategy(event.target.value as ExtractionStrategy)
                  }
                >
                  <option value="ARTICLE">Article</option>
                  <option value="CATALOG">Catalog</option>
                </select>
              </label>
            </div>
            {schemas.failure && (
              <p className="mb-3 text-[11px] text-danger" role="alert">
                {schemas.failure}
              </p>
            )}
            {chosenSchema?.schemaRevisionId === schemaRevisionId && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface-muted px-3 py-2">
                <p className="text-[11px] leading-snug text-ink-muted">
                  {chosenSchema.stabilisedAt
                    ? 'This schema is stabilised — full collection-level Batch Extractions are unlocked.'
                    : selected.size > PILOT_BATCH_SELECTION_LIMIT
                      ? `This schema hasn't been stabilised yet: a batch over ${PILOT_BATCH_SELECTION_LIMIT} Source Documents needs a stabilised schema. Pilot it on ${PILOT_BATCH_SELECTION_LIMIT} or fewer first, review the results, then stabilise.`
                      : 'This schema is still piloting. Run this small selection, review the results, then stabilise it to unlock a full collection run.'}
                </p>
                {!chosenSchema.stabilisedAt && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={stabilisingChosenSchema}
                    onClick={() => void stabiliseChosenSchema()}
                  >
                    {stabilisingChosenSchema ? 'Stabilising…' : 'Stabilise schema'}
                  </Button>
                )}
              </div>
            )}
            {stabiliseChosenSchemaError && (
              <p className="mb-3 text-[11px] text-danger" role="alert">
                {stabiliseChosenSchemaError}
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
                initialChatDraft={pendingSchemaEditDraft}
                onChatDraftConsumed={() => setPendingSchemaEditDraft(null)}
                registerFlush={(flush) => {
                  savedSchemaFlush.current = flush
                }}
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
                {(activeSuggestion?.failure || suggestion.context.error) && (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[11px] text-danger" role="alert">
                        {activeSuggestion?.failure?.message ??
                          suggestion.context.error}
                      </p>
                      {suggestion.matches('failed') && (
                        <Button
                          size="sm"
                          disabled={selected.size === 0 || overSelectionLimit}
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
                {activeSuggestion && activeSuggestion.sources.length > 0 && (
                  <SuggestionSourceProgress
                    suggestion={activeSuggestion}
                    documentName={documentName}
                  />
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
                {suggestedFields?.status === 'heterogeneous' && (
                  <p className="text-xs text-ink-muted">
                    No reliable common field set was found. Choose an existing
                    Extraction Schema or change the selection.
                  </p>
                )}
                {suggestedFields?.status === 'ready' && (
                  <div
                    className="h-[32rem] overflow-hidden rounded-md border border-line bg-surface"
                    aria-busy={preparingSuggestedBatch}
                    inert={preparingSuggestedBatch ? true : undefined}
                  >
                    <SuggestedSchemaEditor
                      key={suggestedFields.selectionKey}
                      proposal={suggestedFields}
                      proposalVersion={{
                        draftVersion: activeSuggestion?.draftVersion ?? 0,
                        finishedAt: activeSuggestion?.finishedAt ?? null,
                      }}
                      sourceDocumentName={`${selected.size} selected Source Document${selected.size === 1 ? '' : 's'}`}
                      readOnly={confirmedSuggestion !== null}
                      showRegenerate={confirmedSuggestion === null}
                      onGenerateInstructions={regenerateSuggestedFields}
                      onProposalEdit={updateSuggestedDefinition}
                      onPendingLocalEditChange={
                        setSuggestionHasPendingLocalEdit
                      }
                    />
                  </div>
                )}
                {suggestedFields?.status === 'ready' && confirmedSuggestion && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={selected.size === 0 || overSelectionLimit}
                    onClick={regenerateSuggestedFields}
                  >
                    Regenerate
                  </Button>
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
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="block truncate text-xs font-semibold text-ink">
                            {document.name}
                          </span>
                          {alreadyReviewed.has(document.sourceDocumentId) && (
                            <span
                              className="shrink-0 rounded-full bg-green-soft px-1.5 py-0.5 text-[10px] font-semibold text-green"
                              title="Already reviewed under this Schema Revision — this run will reuse that result instead of re-extracting it."
                            >
                              Reuses reviewed result
                            </span>
                          )}
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
            projectContextId={projectContextId}
            schemaStabilised={currentPinnedBatchSchema?.stabilisedAt != null}
            priorRoundBatch={priorRoundBatch}
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
            onEditSchemaField={(context) => editSchemaFieldFromGrid(openBatch, context)}
            onStabilised={() => {
              setPinnedBatchSchemaReload((value) => value + 1)
              setStabiliseNudge(openBatch.schemaRevisionId)
            }}
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
      {stabiliseNudge && (
        <GuidedNextStep
          title="Schema stabilised"
          description="Collection-level Batch Extraction is unlocked. Select all your Source Documents and run the full batch."
          actionLabel="Run the full collection"
          onAction={() => {
            setSchemaRevisionId(stabiliseNudge)
            setSelected(new Set(sourceDocumentIds))
            clearSuggestedFields()
            setRunFailure(null)
            setRunFailureCode(null)
            setPreparing(true)
          }}
          onDismiss={() => setStabiliseNudge(null)}
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
  initialChatDraft,
  onChatDraftConsumed,
  registerFlush,
}: {
  projectContextId: string
  chosenSchema: SchemaRevision
  sourceDocumentName: string
  /** Seeds the schema chat input with a flagged field's context, so "Edit
   *  schema" from the review grid arrives with that context already in the
   *  draft (schema-issue-flagging). */
  initialChatDraft?: string | null
  onChatDraftConsumed?(): void
  registerFlush: (
    flush: (() => Promise<AcknowledgedSchemaRevision | null>) | null,
  ) => void
}) {
  const schema = useDurableCurrentSchemaRevision({
    projectContextId,
    extractionSchema: chosenSchema,
    debounceMs: 0,
  })
  useEffect(() => {
    registerFlush(() => schema.flush())
    return () => registerFlush(null)
  }, [schema, registerFlush])
  const snap = useSyncExternalStore(schema.subscribe, schema.snapshot)
  const failure =
    snap.save?.status === 'error'
      ? snap.save.error?.message ?? 'The schema could not be saved.'
      : null
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
          initialChatDraft={initialChatDraft}
          onChatDraftConsumed={onChatDraftConsumed}
        />
      </section>
      {failure && (
        <p className="-mt-3 mb-5 text-[11px] text-danger" role="alert">
          {failure}
        </p>
      )}
    </>
  )
}

/**
 * A Batch Schema Suggestion's editable proposal. Nothing here is durable:
 * every committed edit forwards into the caller-owned suggestion draft
 * machinery, and chat-driven edits stay unavailable exactly as before.
 */
export function SuggestedSchemaEditor({
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
      previous.finishedAt === proposalVersion.finishedAt
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
