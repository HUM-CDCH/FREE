import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  exportBatchExtractionResults,
  type ExportChoices,
  type ExportFormat,
} from 'extraction-result-export'
import ExtractionResultExportControl from '../ExtractionResultExportControl'
import type { NavigableRoute } from '../projectNavigation'
import {
  getSchemaRevision,
  listExtractionSchemas,
} from '../schemaRevisions'
import type { SchemaRevision } from '../../shared/schemaRevision.contract'
import { Button } from '../ui'
import {
  BATCH_EXTRACTION_SELECTION_LIMIT,
  batchExtractionProgress,
  type BatchExtraction,
  type BatchExtractionMember,
} from '../../shared/batchExtraction.contract'
import type { SchemaDefinition } from 'extraction/schema'
import type { BatchSchemaSuggestion } from '../../shared/batchSchemaSuggestion.contract'
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
  BatchSchemaSuggestionRequestError,
  createBatchSchemaSuggestion,
  getBatchExtractionResults,
  listBatchExtractions,
  listBatchSchemaSuggestions,
  openBatchExtraction,
  retryBatchSchemaSuggestion,
  runBatchSchemaSuggestion,
  updateBatchSchemaSuggestionDraft,
} from './batchExtractions'

type Screen = 'history' | 'prepare' | 'members'

type SourceDocument = {
  sourceDocumentId: string
  name: string
  pageCount: number | null
}

type SuggestionDraftVersion = Pick<
  BatchSchemaSuggestion,
  'draftVersion' | 'finishedAt'
>

type ExtractionSchemas = Awaited<ReturnType<typeof listExtractionSchemas>>

const SUGGEST_SCHEMA = '__suggest_common_fields__'

/** A read is loading while it has neither answered nor failed. */
type Read<T> = { value: T | null; failure: string | null }

type SuggestionEvent =
  | { type: 'reset' }
  | { type: 'suggestion.requested' }
  | { type: 'proposal.changed'; definition: SchemaDefinition }
  | { type: 'run.requested' }

const reading = <T,>(read: Read<T>) =>
  read.value === null && read.failure === null

const control =
  'rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30'

function failureText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function stamp(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/** What one member's persisted Extraction says. */
function memberStatus(member: BatchExtractionMember): {
  label: string
  tone: string
  message: string | null
} {
  const extraction = member.latestExtraction
  if (member.executionStatus === 'RUNNING')
    return { label: 'Running', tone: 'text-accent', message: null }
  if (member.executionStatus === 'FAILED' && !extraction)
    return {
      label: 'No result in this batch',
      tone: 'text-danger',
      message:
        member.executionFailureMessage ??
        'The member Extraction did not finish.',
    }
  if (!extraction)
    return {
      label: member.executionStatus === 'QUEUED' ? 'Queued' : 'Not run',
      tone: 'text-ink-faint',
      message: null,
    }
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
  if (extraction.reviewedAt)
    return { label: 'Reviewed', tone: 'text-success', message: null }
  if (!extraction.reviewable)
    return {
      label: 'No reviewable result',
      tone: 'text-ink-muted',
      message: 'The Extraction produced no grounded Evidence to review.',
    }
  return { label: 'Needs review', tone: 'text-accent', message: null }
}

/** One Batch Extraction's persisted state as a sentence. */
function batchStatus(batch: BatchExtraction) {
  const progress = batchExtractionProgress(batch)
  if (batch.executionStatus === 'QUEUED')
    return { label: 'Queued', tone: 'text-ink-muted' }
  if (batch.executionStatus === 'RUNNING')
    return {
      label: `Running, ${progress.extracted} of ${progress.total} completed`,
      tone: 'text-accent',
    }
  if (batch.executionStatus === 'FAILED')
    return {
      label: batch.executionFailureMessage ?? 'Execution failed',
      tone: 'text-danger',
    }
  const withoutResult = batch.members.filter(
    (member) =>
      member.executionStatus === 'FAILED' && member.latestExtraction === null,
  ).length
  const parts = [
    withoutResult
      ? `${withoutResult} without a result`
      : null,
    progress.needsReview ? `${progress.needsReview} need review` : null,
    progress.unreviewable
      ? `${progress.unreviewable} with no reviewable result`
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
  return `${count} Source Document${count === 1 ? '' : 's'} · Article`
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
  onNavigate,
}: {
  projectContextId: string
  sourceDocuments: readonly SourceDocument[]
  /** The routed Batch Extraction, so one is linkable and survives a refresh. */
  openBatchExtractionId: string | null
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
      ? 'members'
      : 'history'
  const [batches, setBatches] = useState<Read<BatchExtraction[]>>({
    value: null,
    failure: null,
  })
  const [reload, setReload] = useState(0)
  const [openingBatch, setOpeningBatch] = useState(false)
  const [runFailure, setRunFailure] = useState<string | null>(null)
  // A replayed selection reopens a Batch Extraction the researcher already has,
  // which is indistinguishable from nothing happening unless it is said.
  const [runNotice, setRunNotice] = useState<string | null>(null)
  const [schemas, setSchemas] = useState<Read<ExtractionSchemas>>({
    value: null,
    failure: null,
  })
  const [schemaRevisionId, setSchemaRevisionId] = useState('')
  const [chosenSchema, setChosenSchema] = useState<SchemaRevision | null>(null)
  const [pinnedBatchSchema, setPinnedBatchSchema] =
    useState<SchemaRevision | null>(null)
  const [pinnedBatchSchemaFailure, setPinnedBatchSchemaFailure] = useState<{
    schemaRevisionId: string
    message: string
  } | null>(null)
  const [pinnedBatchSchemaReload, setPinnedBatchSchemaReload] = useState(0)
  const [exportCoverage, setExportCoverage] = useState<{
    batchExtractionId: string
    message: string
  } | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(sourceDocumentIds),
  )
  const [filter, setFilter] = useState('')
  const opening = useRef(false)
  // The saved-schema editor registers its flush so opening a Batch Extraction
  // can wait for the chosen schema's pending save.
  const savedSchemaFlush = useRef<(() => Promise<AcknowledgedSchemaRevision | null>) | null>(null)
  const historyGeneration = useRef(0)
  const [suggestions, setSuggestions] = useState<Read<BatchSchemaSuggestion[]>>({
    value: null,
    failure: null,
  })
  const [activeSuggestionId, setActiveSuggestionId] = useState<string | null>(
    null,
  )
  const [suggestionRun, setSuggestionRun] = useState(false)
  const [draftConflict, setDraftConflict] = useState(false)
  const suggestionSave = useRef<number | undefined>(undefined)
  const suggestionSaveInFlight =
    useRef<Promise<BatchSchemaSuggestion | null> | null>(null)
  const pendingSuggestionDraft = useRef<{
    snapshot: BatchSchemaSuggestion
    definition: SchemaDefinition
  } | null>(null)
  const activeSuggestion =
    suggestions.value?.find(
      (item) => item.batchSchemaSuggestionId === activeSuggestionId,
    ) ?? null
  const confirmedSuggestion =
    activeSuggestion?.confirmedSchemaRevisionId !== null
      ? activeSuggestion
      : null
  const suggestionProposal =
    activeSuggestion?.phase === 'READY' &&
    activeSuggestion.draft
      ? {
          status: 'ready' as const,
          selectionKey: activeSuggestion.selectionKey,
          ...activeSuggestion.draft,
          coverage: activeSuggestion.coverage ?? [],
        }
      : activeSuggestion?.phase === 'HETEROGENEOUS'
        ? {
            status: 'heterogeneous' as const,
            selectionKey: activeSuggestion.selectionKey,
          }
        : null
  const suggestion = {
    context: {
      proposal: suggestionProposal,
      failure: activeSuggestion?.failure ?? null,
    },
    matches: (state: string) =>
      (state === 'idle' && activeSuggestion === null) ||
      (state === 'suggesting' &&
        (activeSuggestion?.executionStatus === 'QUEUED' ||
          activeSuggestion?.executionStatus === 'RUNNING')) ||
      (state === 'suggestionFailed' &&
        activeSuggestion?.executionStatus === 'FAILED') ||
      ((state === 'confirming' || state === 'opening') && suggestionRun),
  }

  const documentName = useCallback(
    (sourceDocumentId: string) =>
      sourceDocuments.find(
        (document) => document.sourceDocumentId === sourceDocumentId,
      )?.name ?? 'Source Document',
    [sourceDocuments],
  )

  const clearSuggestedFields = () => {
    clearTimeout(suggestionSave.current)
    suggestionSave.current = undefined
    pendingSuggestionDraft.current = null
    setActiveSuggestionId(null)
    setDraftConflict(false)
  }

  useEffect(() => {
    const controller = new AbortController()
    const requestGeneration = ++historyGeneration.current
    listBatchExtractions(projectContextId, controller.signal).then(
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
    )
    return () => controller.abort()
  }, [projectContextId, reload])

  useEffect(() => {
    const controller = new AbortController()
    listBatchSchemaSuggestions(projectContextId, controller.signal).then(
      (listed) => {
        if (!controller.signal.aborted)
          setSuggestions({ value: listed, failure: null })
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setSuggestions({
            value: null,
            failure: failureText(
              error,
              'Batch Schema Suggestions could not be read.',
            ),
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
    const refresh = () => setReload((value) => value + 1)
    const interval = window.setInterval(refresh, 2_000)
    return () => window.clearInterval(interval)
  }, [batches.value, suggestions.value])

  useEffect(() => {
    const refresh = () => setReload((value) => value + 1)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  const batchList = batches.value ?? []
  const openBatch =
    batchList.find(
      (batch) => batch.batchExtractionId === openBatchExtractionId,
    ) ?? null
  const showHistory = useCallback(() => {
    setPreparing(false)
    onNavigate({ kind: 'project', projectContextId, tab: 'extractions' })
  }, [onNavigate, projectContextId])
  const pinnedExtractionSchemaId =
    screen === 'members' ? (openBatch?.extractionSchemaId ?? null) : null
  const pinnedSchemaRevisionId =
    screen === 'members' ? (openBatch?.schemaRevisionId ?? null) : null
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
      ],
      failure: null,
    }))
  }, [])
  const acceptOpenedBatch = useCallback(
    (opened: Awaited<ReturnType<typeof openBatchExtraction>>) => {
      recordBatch(opened.batchExtraction)
      setSelected(new Set())
      setRunNotice(
        opened.disposition === 'replayed'
          ? 'This selection had already been run. Its Batch Extraction is reopened below — open it and choose Run again to run the same selection fresh.'
          : null,
      )
      showHistory()
    },
    [recordBatch, showHistory],
  )
  const replaceSuggestion = useCallback((next: BatchSchemaSuggestion) => {
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

  const saveSuggestedDraftRef = useRef<
    (
      snapshot: BatchSchemaSuggestion,
      definition: SchemaDefinition,
    ) => Promise<BatchSchemaSuggestion | null>
  >(async () => null)
  const saveSuggestedDraft = useCallback(
    (
      snapshot: BatchSchemaSuggestion,
      definition: SchemaDefinition,
    ): Promise<BatchSchemaSuggestion | null> => {
      if (suggestionSaveInFlight.current)
        return suggestionSaveInFlight.current


      let succeeded = false
      const request = (async () => {
        try {
          const saved = await updateBatchSchemaSuggestionDraft(
            projectContextId,
            snapshot.batchSchemaSuggestionId,
            definition,
            snapshot.draftVersion,
          )
          succeeded = true
          if (
            pendingSuggestionDraft.current?.snapshot
              .batchSchemaSuggestionId === saved.batchSchemaSuggestionId &&
            pendingSuggestionDraft.current.definition === definition
          )
            pendingSuggestionDraft.current = null
          const newer = pendingSuggestionDraft.current
          if (
            newer?.snapshot.batchSchemaSuggestionId ===
            saved.batchSchemaSuggestionId
          ) {
            newer.snapshot = saved
            replaceSuggestion({ ...saved, draft: newer.definition })
          } else replaceSuggestion(saved)
          setDraftConflict(false)
          return saved
        } catch (error) {
          if (
            error instanceof BatchSchemaSuggestionRequestError &&
            error.failure.code === 'draft_conflict'
          ) {
            setDraftConflict(true)
            return null
          }
          setRunFailure(
            failureText(error, 'The suggested draft could not be saved.'),
          )
          return null
        } finally {
          suggestionSaveInFlight.current = null
          if (
            succeeded &&
            pendingSuggestionDraft.current &&
            suggestionSave.current === undefined
          ) {
            const pending = pendingSuggestionDraft.current
            void saveSuggestedDraftRef.current(
              pending.snapshot,
              pending.definition,
            )
          }
        }
      })()
      suggestionSaveInFlight.current = request
      return request
    },
    [projectContextId, replaceSuggestion],
  )
  useEffect(() => {
    saveSuggestedDraftRef.current = saveSuggestedDraft
  }, [saveSuggestedDraft])
  useEffect(() => {
    const flush = () => {
      clearTimeout(suggestionSave.current)
      suggestionSave.current = undefined
      const pending = pendingSuggestionDraft.current
      if (!pending) return
      void saveSuggestedDraftRef.current(pending.snapshot, pending.definition)
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

  const sendSuggestion = (event: SuggestionEvent) => {
    if (event.type === 'reset') {
      clearSuggestedFields()
      return
    }
    if (event.type === 'suggestion.requested') {
      void createBatchSchemaSuggestion(projectContextId, [...selected]).then(
        (created) => {
          replaceSuggestion(created)
          setActiveSuggestionId(created.batchSchemaSuggestionId)
          setDraftConflict(false)
          setReload((value) => value + 1)
        },
        (error: unknown) =>
          setRunFailure(
            failureText(error, 'Common fields could not be suggested.'),
          ),
      )
      return
    }
    if (event.type === 'proposal.changed' && activeSuggestion) {
      const optimistic = { ...activeSuggestion, draft: event.definition }
      replaceSuggestion(optimistic)
      setDraftConflict(false)
      pendingSuggestionDraft.current = {
        snapshot: activeSuggestion,
        definition: event.definition,
      }
      clearTimeout(suggestionSave.current)
      suggestionSave.current = window.setTimeout(() => {
        suggestionSave.current = undefined
        const pending = pendingSuggestionDraft.current
        if (!pending) return
        void saveSuggestedDraft(pending.snapshot, pending.definition)
      }, 500)
      return
    }
    if (event.type === 'run.requested' && activeSuggestion?.draft) {
      clearTimeout(suggestionSave.current)
      suggestionSave.current = undefined
      setSuggestionRun(true)
      void (async () => {
        try {
          let saved = activeSuggestion
          while (
            suggestionSaveInFlight.current ||
            pendingSuggestionDraft.current
          ) {
            const inFlight = suggestionSaveInFlight.current
            if (inFlight) {
              const acknowledged = await inFlight
              if (!acknowledged)
                throw new Error('The suggested draft could not be saved.')
              saved = acknowledged
              continue
            }
            const pending = pendingSuggestionDraft.current!
            const acknowledged = await saveSuggestedDraftRef.current(
              pending.snapshot,
              pending.definition,
            )
            if (!acknowledged)
              throw new Error('The suggested draft could not be saved.')
            saved = acknowledged
          }
          const started = await runBatchSchemaSuggestion(
            projectContextId,
            saved.batchSchemaSuggestionId,
            'ARTICLE',
          )
          replaceSuggestion(started)
          setSelected(new Set())
          showHistory()
          setReload((value) => value + 1)
        } catch (error) {
          if (
            error instanceof BatchSchemaSuggestionRequestError &&
            error.failure.code === 'draft_conflict'
          )
            setDraftConflict(true)
          else
            setRunFailure(
              failureText(
                error,
                'The suggested Batch Extraction could not start.',
              ),
            )
        } finally {
          setSuggestionRun(false)
        }
      })()
    }
  }

  const suggestFields = () => {
    if (selected.size === 0 || overSelectionLimit) return
    sendSuggestion({ type: 'suggestion.requested' })
  }

  const regenerateSuggestedFields = () => {
    if (!activeSuggestion || selected.size === 0 || overSelectionLimit) return
    setRunFailure(null)
    setRunNotice(null)
    void retryBatchSchemaSuggestion(
      projectContextId,
      activeSuggestion.batchSchemaSuggestionId,
    ).then(
      (retried) => {
        replaceSuggestion(retried)
        setDraftConflict(false)
        setReload((value) => value + 1)
      },
      (error: unknown) =>
        setRunFailure(
          failureText(error, 'The suggestion could not be regenerated.'),
        ),
    )
  }

  const updateSuggestedDefinition = (
    update: (definition: SchemaDefinition) => SchemaDefinition,
  ) => {
    const proposal = suggestion.context.proposal
    if (proposal?.status !== 'ready') return
    sendSuggestion({
      type: 'proposal.changed',
      definition: update({
        recordDescription: proposal.recordDescription,
        schemaNodes: proposal.schemaNodes,
      }),
    })
  }

  const openExistingSchemaBatch = async () => {
    if (opening.current) return
    opening.current = true
    setOpeningBatch(true)
    setRunFailure(null)
    setRunNotice(null)
    try {
      const savedRevision = await savedSchemaFlush.current?.()
      const request = {
        projectContextId,
        schemaRevisionId: savedRevision?.schemaRevisionId ?? schemaRevisionId,
        strategy: 'ARTICLE' as const,
        sourceDocumentIds: [...selected],
      }
      acceptOpenedBatch(await openBatchExtraction(request))
    } catch (error) {
      setRunFailure(
        failureText(error, 'The Batch Extraction could not be opened.'),
      )
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
    if (opening.current) return
    opening.current = true
    setOpeningBatch(true)
    setRunFailure(null)
    setRunNotice(null)
    try {
      const opened = await openBatchExtraction({
        projectContextId,
        schemaRevisionId: batch.schemaRevisionId,
        strategy: 'ARTICLE',
        sourceDocumentIds: batch.members.map(
          (member) => member.sourceDocumentId,
        ),
        force: true,
      })
      recordBatch(opened.batchExtraction)
      setSelected(new Set())
      openMembers(opened.batchExtraction)
    } catch (error) {
      setRunFailure(
        failureText(error, 'The Batch Extraction could not be run again.'),
      )
    } finally {
      opening.current = false
      setOpeningBatch(false)
    }
  }

  const openNewBatch = () => {
    setRunFailure(null)
    setRunNotice(null)
    if (schemaRevisionId === SUGGEST_SCHEMA) {
      if (
        confirmedSuggestion ||
        suggestion.context.proposal?.status !== 'ready' ||
        !suggestion.context.proposal.recordDescription.trim() ||
        suggestion.context.proposal.schemaNodes.some(
          (node) => !node.name.trim(),
        ) ||
        new Set(
          suggestion.context.proposal.schemaNodes.map((node) => node.name.trim()),
        ).size !== suggestion.context.proposal.schemaNodes.length ||
        draftConflict
      )
        return
      sendSuggestion({ type: 'run.requested' })
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

  const openStatus = openBatch ? batchStatus(openBatch) : null
  const openBatchHasSuccessfulResult =
    openBatch?.members.some(
      (member) => member.latestExtraction?.outcome === 'SUCCEEDED',
    ) ?? false
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
  const suggestedFields = suggestion.context.proposal
  const selectedSchema = schemas.value?.find(
    (schema) => schema.currentRevision?.schemaRevisionId === schemaRevisionId,
  )
  const suggestingFields = suggestion.matches('suggesting')
  const preparingSuggestedBatch =
    suggestion.matches('confirming') || suggestion.matches('opening')
  const openingAnyBatch = openingBatch || preparingSuggestedBatch
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
      className="pt-1"
      tabIndex={0}
    >
      <div className="mb-4 flex min-h-10 items-center justify-between gap-3 border-b border-line pb-3">
        <div className="flex min-w-0 items-center gap-3">
          {screen !== 'history' && (
            <button
              className="shrink-0 rounded-md text-xs font-semibold text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
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
          <p className="truncate text-xs font-semibold text-ink">{heading}</p>
        </div>
        {/* On `prepare` this button only reopens the screen already shown. */}
        {screen !== 'prepare' && (
          <Button
            variant={screen === 'members' ? 'secondary' : 'primary'}
            size="md"
            disabled={openingAnyBatch}
            onClick={() => {
              setSelected(new Set(sourceDocumentIds))
              setPreparing(true)
            }}
          >
            {openingAnyBatch
              ? 'Opening Batch Extraction…'
              : 'New Batch Extraction'}
          </Button>
        )}
      </div>
      {runFailure && (
        <p className="mb-3 text-[11px] leading-snug text-danger" role="alert">
          {runFailure}
        </p>
      )}
      {runNotice && (
        <p className="mb-3 text-[11px] leading-snug text-ink-muted" role="status">
          {runNotice}
        </p>
      )}

      <div className="min-h-[430px]">
        {screen === 'history' ? (
          batchesUnread ? (
            batchesUnread
          ) : batchList.length === 0 ? (
            <p className="py-6 text-center text-xs text-ink-muted">
              No Batch Extractions yet.
            </p>
          ) : (
            <ul className="space-y-1" aria-live="polite">
              {batchList.map((batch) => {
                const status = batchStatus(batch)
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
                        <span
                          className="ml-3 text-ink-faint"
                          aria-hidden="true"
                        >
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
                    setActiveSuggestionId(
                      matching?.batchSchemaSuggestionId ?? null,
                    )
                    setDraftConflict(false)
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
                {suggestion.context.failure && (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[11px] text-danger" role="alert">
                        {suggestion.context.failure.message}
                      </p>
                      {suggestion.matches('suggestionFailed') && (
                        <Button
                          size="sm"
                          disabled={selected.size === 0 || overSelectionLimit}
                          onClick={() => {
                            if (!activeSuggestion) return
                            void retryBatchSchemaSuggestion(
                              projectContextId,
                              activeSuggestion.batchSchemaSuggestionId,
                            ).then(replaceSuggestion, (error: unknown) =>
                              setRunFailure(
                                failureText(
                                  error,
                                  'The suggestion could not be retried.',
                                ),
                              ),
                            )
                          }}
                        >
                          Try again
                        </Button>
                      )}
                    </div>
                    {activeSuggestion &&
                      activeSuggestion.sources.some(
                        (source) => source.failure !== null,
                      ) && (
                      <ul className="space-y-1 text-[11px] text-danger">
                        {activeSuggestion.sources
                          .filter((source) => source.failure !== null)
                          .map((source) => (
                            <li key={source.sourceDocumentId}>
                              {documentName(source.sourceDocumentId)}:{' '}
                              {source.failure!.message}
                            </li>
                          ))}
                      </ul>
                    )}
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
                        setDraftConflict(false)
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
                  (schemaRevisionId === SUGGEST_SCHEMA
                    ? confirmedSuggestion !== null ||
                      suggestedFields?.status !== 'ready' ||
                      !suggestedFields.recordDescription.trim() ||
                      draftConflict
                    : !schemaRevisionId) ||
                  overSelectionLimit ||
                  openingAnyBatch
                }
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
        ) : (
          <>
            <div className="mb-5 flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-end">
              <p className="text-[11px] text-ink-faint">
                {schemaLine(openBatch)} ·{' '}
                Article
              </p>
              <p className={`text-xs font-semibold ${openStatus!.tone}`}>
                {openStatus!.label}
              </p>
              <div className="flex items-start gap-2">
                <div className="flex flex-col items-end gap-1">
                  <ExtractionResultExportControl
                    schema={
                      currentPinnedBatchSchema && {
                        recordDescription:
                          currentPinnedBatchSchema.recordDescription,
                        schemaNodes: currentPinnedBatchSchema.schemaNodes,
                      }
                    }
                    disabled={!openBatchHasSuccessfulResult}
                    disabledReason={
                      !openBatchHasSuccessfulResult
                        ? 'No successful Extraction Results are available to export.'
                        : null
                    }
                    onExport={exportOpenBatch}
                  />
                  {currentPinnedBatchSchemaFailure && (
                    <div className="flex max-w-72 flex-col items-end gap-1">
                      <p
                        className="text-right text-[11.5px] leading-snug text-danger"
                        role="alert"
                      >
                        {currentPinnedBatchSchemaFailure}
                      </p>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          setPinnedBatchSchemaReload((value) => value + 1)
                        }
                      >
                        Retry Schema Revision
                      </Button>
                    </div>
                  )}
                  {exportCoverage?.batchExtractionId ===
                    openBatch.batchExtractionId && (
                    <p
                      className="max-w-96 text-right text-[11.5px] leading-snug text-ink-muted"
                      role="status"
                    >
                      {exportCoverage.message}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={openingAnyBatch}
                  onClick={() => {
                    void runOpenBatchAgain(openBatch)
                  }}
                >
                  {openingAnyBatch ? 'Running again…' : 'Run again'}
                </Button>
              </div>
            </div>
            <ul className="space-y-1" aria-label="Batch Extraction members">
              {openBatch.members.map((member) => {
                const status = memberStatus(member)
                return (
                  <li key={member.sourceDocumentId}>
                    <button
                      className="w-full rounded-md px-2 py-3 text-left outline-none hover:bg-line/20 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:hover:bg-transparent"
                      type="button"
                      disabled={!member.latestExtraction}
                      onClick={() => {
                        if (!member.latestExtraction) return
                        onNavigate({
                          kind: 'document',
                          projectContextId,
                          sourceDocumentId: member.sourceDocumentId,
                          extractionId: member.latestExtraction.extractionId,
                        })
                      }}
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

/**
 * The chosen Extraction Schema's fields before running a Batch Extraction.
 * Edits append revisions immediately (debounce 0): the run that follows must
 * bind to what the researcher just saw.
 */
function SavedSchemaEditor({
  projectContextId,
  chosenSchema,
  sourceDocumentName,
  registerFlush,
}: {
  projectContextId: string
  chosenSchema: SchemaRevision
  sourceDocumentName: string
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
function SuggestedSchemaEditor({
  proposal,
  proposalVersion,
  sourceDocumentName,
  readOnly,
  showRegenerate,
  onGenerateInstructions,
  onProposalEdit,
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
    />
  )
}
