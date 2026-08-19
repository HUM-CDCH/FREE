import { useCallback, useEffect, useRef, useState } from 'react'
import type { NavigableRoute } from '../projectNavigation'
import {
  appendSchemaRevision,
  getSchemaRevision,
  listExtractionSchemas,
  listSchemaRevisions,
} from '../schemaRevisions'
import type {
  SchemaRevision,
  SchemaRevisionSummary,
} from '../../shared/schemaRevision.contract'
import { Button } from '../ui'
import {
  BATCH_EXTRACTION_SELECTION_LIMIT,
  batchExtractionProgress,
  type BatchExtraction,
  type BatchExtractionMember,
} from '../../shared/batchExtraction.contract'
import type { ExtractionStrategy } from '../../shared/extraction.contract'
import type { SchemaDefinition } from '../../shared/schemaNode'
import type { BatchSchemaSuggestion } from '../../shared/batchSchemaSuggestion.contract'
import SchemaPanel from '../SchemaPanel'
import {
  createSchemaSaveCoordinator,
  type SchemaSaveCoordinator,
  type SchemaSaveState,
} from '../schemaSaveCoordinator'
import {
  BatchSchemaSuggestionRequestError,
  createBatchSchemaSuggestion,
  listBatchExtractions,
  listBatchSchemaSuggestions,
  openBatchExtraction,
  retryBatchExtraction,
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

type ExtractionSchemas = Awaited<ReturnType<typeof listExtractionSchemas>>

const SUGGEST_SCHEMA = '__suggest_common_fields__'

/** A read is loading while it has neither answered nor failed. */
type Read<T> = { value: T | null; failure: string | null }

type SuggestionEvent =
  | { type: 'reset' }
  | { type: 'suggestion.requested' }
  | { type: 'proposal.changed'; definition: SchemaDefinition }
  | { type: 'run.requested'; strategy: ExtractionStrategy }

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
  const sourceDocumentIds = sourceDocuments.map(
    (document) => document.sourceDocumentId,
  )
  const [screen, setScreen] = useState<Screen>('history')
  const [batches, setBatches] = useState<Read<BatchExtraction[]>>({
    value: null,
    failure: null,
  })
  const [reload, setReload] = useState(0)
  const [openBatchId, setOpenBatchId] = useState<string | null>(null)
  const [openingBatch, setOpeningBatch] = useState(false)
  const [runFailure, setRunFailure] = useState<string | null>(null)
  const [schemas, setSchemas] = useState<Read<ExtractionSchemas>>({
    value: null,
    failure: null,
  })
  const [schemaRevisionId, setSchemaRevisionId] = useState('')
  const [chosenSchema, setChosenSchema] = useState<SchemaRevision | null>(null)
  const [savedSchemaState, setSavedSchemaState] =
    useState<SchemaSaveState | null>(null)
  const [savedSchemaHistory, setSavedSchemaHistory] = useState<
    SchemaRevisionSummary[]
  >([])
  const [strategy, setStrategy] = useState<ExtractionStrategy>('ARTICLE')
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(sourceDocumentIds),
  )
  const [filter, setFilter] = useState('')
  const opening = useRef(false)
  const savedSchemaCoordinator = useRef<SchemaSaveCoordinator | null>(null)
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
  const suggestionSave = useRef<ReturnType<typeof setTimeout> | null>(null)
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
    if (suggestionSave.current) clearTimeout(suggestionSave.current)
    suggestionSave.current = null
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
        if (!controller.signal.aborted) {
          setChosenSchema(revision)
          setSavedSchemaState({
            status: 'saved',
            acknowledged: revision,
            draft: {
              recordDescription: revision.recordDescription,
              schemaNodes: revision.schemaNodes,
            },
          })
        }
      },
      () => {},
    )
    return () => controller.abort()
  }, [projectContextId, schemaRevisionId, schemas.value])

  useEffect(() => {
    if (!chosenSchema) return
    const coordinator = createSchemaSaveCoordinator(
      chosenSchema,
      (expectedRevisionNumber, definition) =>
        appendSchemaRevision(
          projectContextId,
          chosenSchema.extractionSchemaId,
          expectedRevisionNumber,
          definition,
        ),
      0,
      setSavedSchemaState,
    )
    savedSchemaCoordinator.current = coordinator
    return () => {
      coordinator.dispose()
      if (savedSchemaCoordinator.current === coordinator)
        savedSchemaCoordinator.current = null
    }
  }, [chosenSchema, projectContextId])

  useEffect(() => {
    if (!chosenSchema) return
    const controller = new AbortController()
    void listSchemaRevisions(
      projectContextId,
      chosenSchema.extractionSchemaId,
      20,
      controller.signal,
    ).then(setSavedSchemaHistory, () => setSavedSchemaHistory([]))
    return () => controller.abort()
  }, [
    chosenSchema,
    projectContextId,
    savedSchemaState?.acknowledged.schemaRevisionId,
  ])

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
    batchList.find((batch) => batch.batchExtractionId === openBatchId) ?? null
  const acceptOpenedBatch = useCallback(
    (opened: Awaited<ReturnType<typeof openBatchExtraction>>) => {
      const batch = opened.batchExtraction
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
      setOpenBatchId(batch.batchExtractionId)
      setSelected(new Set())
      setScreen('history')
    },
    [],
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

  const saveSuggestedDraft = useCallback(
    async (snapshot: BatchSchemaSuggestion, definition: SchemaDefinition) => {
      try {
        const saved = await updateBatchSchemaSuggestionDraft(
          projectContextId,
          snapshot.batchSchemaSuggestionId,
          definition,
          snapshot.draftVersion,
        )
        replaceSuggestion(saved)
        if (
          pendingSuggestionDraft.current?.snapshot
            .batchSchemaSuggestionId === snapshot.batchSchemaSuggestionId &&
          pendingSuggestionDraft.current.snapshot.draftVersion ===
            snapshot.draftVersion
        )
          pendingSuggestionDraft.current = null
        setDraftConflict(false)
      } catch (error) {
        if (
          error instanceof BatchSchemaSuggestionRequestError &&
          error.failure.code === 'draft_conflict'
        ) {
          setDraftConflict(true)
          return
        }
        setRunFailure(failureText(error, 'The suggested draft could not be saved.'))
      }
    },
    [projectContextId, replaceSuggestion],
  )

  const saveSuggestedDraftRef = useRef(saveSuggestedDraft)
  useEffect(() => {
    saveSuggestedDraftRef.current = saveSuggestedDraft
  }, [saveSuggestedDraft])
  useEffect(() => {
    const flush = () => {
      if (suggestionSave.current) clearTimeout(suggestionSave.current)
      suggestionSave.current = null
      const pending = pendingSuggestionDraft.current
      if (!pending) return
      pendingSuggestionDraft.current = null
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
      if (suggestionSave.current) clearTimeout(suggestionSave.current)
      suggestionSave.current = setTimeout(() => {
        suggestionSave.current = null
        const pending = pendingSuggestionDraft.current
        if (!pending) return
        void saveSuggestedDraft(pending.snapshot, pending.definition)
      }, 500)
      return
    }
    if (event.type === 'run.requested' && activeSuggestion?.draft) {
      if (suggestionSave.current) clearTimeout(suggestionSave.current)
      suggestionSave.current = null
      setSuggestionRun(true)
      void (async () => {
        try {
          const saved = await updateBatchSchemaSuggestionDraft(
            projectContextId,
            activeSuggestion.batchSchemaSuggestionId,
            activeSuggestion.draft!,
            activeSuggestion.draftVersion,
          )
          replaceSuggestion(saved)
          const started = await runBatchSchemaSuggestion(
            projectContextId,
            saved.batchSchemaSuggestionId,
            event.strategy,
          )
          replaceSuggestion(started)
          setOpenBatchId(started.batchExtractionId)
          setSelected(new Set())
          setScreen('history')
          setReload((value) => value + 1)
        } catch (error) {
          if (
            error instanceof BatchSchemaSuggestionRequestError &&
            error.failure.code === 'draft_conflict'
          )
            setDraftConflict(true)
          else
            setRunFailure(
              failureText(error, 'The suggested Batch Extraction could not start.'),
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
    try {
      const savedRevision = await savedSchemaCoordinator.current?.flush()
      const request = {
        projectContextId,
        schemaRevisionId: savedRevision?.schemaRevisionId ?? schemaRevisionId,
        strategy,
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

  const openNewBatch = () => {
    setRunFailure(null)
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
      sendSuggestion({ type: 'run.requested', strategy })
      return
    }
    void openExistingSchemaBatch()
  }

  const openMembers = (batch: BatchExtraction) => {
    setOpenBatchId(batch.batchExtractionId)
    setScreen('members')
  }

  const openStatus = openBatch ? batchStatus(openBatch) : null
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
  const savedSchemaFailure =
    savedSchemaState?.status === 'conflict'
      ? 'The Current Schema Revision changed elsewhere. Reopen this schema before editing it.'
      : savedSchemaState?.status === 'error'
        ? savedSchemaState.error?.message ?? 'The schema could not be saved.'
        : null
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
                setScreen('history')
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
              setScreen('prepare')
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

      <div className="min-h-[430px]">
        {screen === 'history' ? (
          reading(batches) ? (
            <p
              className="py-6 text-center text-xs text-ink-muted"
              aria-busy="true"
            >
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
                    setSavedSchemaHistory([])
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
              <label className="text-[11px] font-semibold text-ink-muted">
                Extraction Strategy
                <select
                  className={`${control} mt-1 block w-full font-normal`}
                  value={strategy}
                  disabled={openingAnyBatch}
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
            {chosenSchema?.schemaRevisionId === schemaRevisionId && (
              <section
                className="mb-5 h-[32rem] overflow-hidden rounded-md border border-line bg-surface"
                aria-label="Extraction Schema fields"
              >
                <SchemaPanel
                  key={chosenSchema.schemaRevisionId}
                  state={{
                    status: 'ready',
                    recordDescription: chosenSchema.recordDescription,
                    nodes: chosenSchema.schemaNodes,
                    inputsKey: chosenSchema.schemaRevisionId,
                  }}
                  sourceDocumentName={
                    selectedSchema
                      ? `${selectedSchema.name} · Schema Revision ${chosenSchema.revisionNumber}`
                      : `Schema Revision ${chosenSchema.revisionNumber}`
                  }
                  showRegenerate={false}
                  documentMarkdown={null}
                  history={savedSchemaHistory}
                  currentRevisionNumber={
                    savedSchemaState?.acknowledged.revisionNumber ??
                    chosenSchema.revisionNumber
                  }
                  onGenerate={() => {}}
                  onCancelGenerate={() => {}}
                  onResetSchema={async () => {
                    const coordinator = savedSchemaCoordinator.current
                    if (!coordinator) return
                    coordinator.edit({
                      recordDescription:
                        coordinator.state.draft.recordDescription,
                      schemaNodes: [],
                    })
                    await coordinator.flush()
                  }}
                  onNodesChange={(nodes, _message, recordDescription) => {
                    const coordinator = savedSchemaCoordinator.current
                    if (!coordinator) return
                    coordinator.edit({
                      recordDescription:
                        recordDescription ??
                        coordinator.state.draft.recordDescription,
                      schemaNodes: nodes,
                    })
                  }}
                  beforeSchemaEdit={async () => {
                    await savedSchemaCoordinator.current?.flush()
                  }}
                  loadRevision={(revisionId) =>
                    getSchemaRevision(
                      projectContextId,
                      chosenSchema.extractionSchemaId,
                      revisionId,
                    )
                  }
                />
              </section>
            )}
            {chosenSchema?.schemaRevisionId === schemaRevisionId &&
              savedSchemaFailure && (
                <p className="-mt-3 mb-5 text-[11px] text-danger" role="alert">
                  {savedSchemaFailure}
                </p>
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
                    <SchemaPanel
                      key={suggestedFields.selectionKey}
                      state={{
                        status: 'ready',
                        recordDescription: suggestedFields.recordDescription,
                        nodes: suggestedFields.schemaNodes,
                        inputsKey: suggestedFields.selectionKey,
                      }}
                      sourceDocumentName={`${selected.size} selected Source Document${selected.size === 1 ? '' : 's'}`}
                      documentMarkdown={null}
                      history={[]}
                      readOnly={confirmedSuggestion !== null}
                      showRegenerate={confirmedSuggestion === null}
                      onGenerate={regenerateSuggestedFields}
                      onCancelGenerate={() => {}}
                      onResetSchema={() =>
                        updateSuggestedDefinition((definition) => ({
                          ...definition,
                          schemaNodes: [],
                        }))
                      }
                      onNodesChange={(nodes, _message, recordDescription) =>
                        updateSuggestedDefinition((definition) => ({
                          recordDescription:
                            recordDescription ?? definition.recordDescription,
                          schemaNodes: nodes,
                        }))
                      }
                      beforeSchemaEdit={async () => {}}
                      loadRevision={async () => {
                        throw new Error('Suggested schemas have no revision history.')
                      }}
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
              <p className={`text-xs font-semibold ${openStatus!.tone}`}>
                {openStatus!.label}
              </p>
              {(openBatch.executionStatus === 'FAILED' ||
                openBatch.members.some(
                  (member) => member.executionStatus === 'FAILED',
                )) && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    void retryBatchExtraction(
                      projectContextId,
                      openBatch.batchExtractionId,
                    ).then(
                      (retried) => {
                        setBatches((current) => ({
                          value: [
                            retried,
                            ...(current.value ?? []).filter(
                              (batch) =>
                                batch.batchExtractionId !==
                                retried.batchExtractionId,
                            ),
                          ],
                          failure: null,
                        }))
                        setReload((value) => value + 1)
                      },
                      (error: unknown) =>
                        setRunFailure(
                          failureText(
                            error,
                            'The Batch Extraction could not be retried.',
                          ),
                        ),
                    )
                  }}
                >
                  Retry unfinished
                </Button>
              )}
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
