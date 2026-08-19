import { useMachine } from '@xstate/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NavigableRoute } from '../projectNavigation'
import { getSchemaRevision, listExtractionSchemas } from '../schemaRevisions'
import type { SchemaRevision } from '../../shared/schemaRevision.contract'
import { Button } from '../ui'
import {
  BATCH_EXTRACTION_SELECTION_LIMIT,
  batchExtractionProgress,
  type BatchExtraction,
  type BatchExtractionMember,
} from '../../shared/batchExtraction.contract'
import type { ExtractionStrategy } from '../../shared/extraction.contract'
import type { SchemaDefinition, SchemaNode } from '../../shared/schemaNode'
import {
  batchSchemaSuggestionIsValid,
  batchSchemaSuggestionMachine,
} from './batchSchemaSuggestionMachine'
import {
  confirmBatchSchemaSuggestion,
  listBatchExtractions,
  mergeBatchSchemaSuggestions,
  openBatchExtraction,
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

const sourceSuggestionFailureLabels = {
  invalid_model_config: 'The Extraction Route configuration is invalid.',
  model_operation_failed: 'The model provider request failed.',
  invalid_model_output: 'The model returned an invalid Schema Suggestion.',
  unexpected_failure: 'Schema Suggestion preparation failed unexpectedly.',
} as const

function stamp(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/** Names the Source Documents that did not run, listing at most three. */
function didNotRunSentence(names: readonly string[]): string {
  const listed = names.slice(0, 3).join(', ')
  const rest = names.length - 3
  return `${names.length} Source Document${names.length === 1 ? '' : 's'} did not run: ${listed}${
    rest > 0 ? ` and ${rest} more` : ''
  }. Open the Batch Extraction to see why.`
}

/** What one member's persisted Extraction says. */
function memberStatus(
  member: BatchExtractionMember,
  requestFailure?: string,
): {
  label: string
  tone: string
  message: string | null
} {
  // A request that never reached a terminal write left the member's stored
  // state untouched, so say what stopped it instead of reporting the state the
  // member still has.
  if (requestFailure)
    return {
      label: 'Did not run',
      tone: 'text-danger',
      message: requestFailure,
    }
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
  const parts = [
    progress.pending ? `${progress.pending} not run` : null,
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
  const [screen, setScreen] = useState<Screen>('history')
  const [batches, setBatches] = useState<Read<BatchExtraction[]>>({
    value: null,
    failure: null,
  })
  const [reload, setReload] = useState(0)
  const [openBatchId, setOpenBatchId] = useState<string | null>(null)
  const [openingBatch, setOpeningBatch] = useState(false)
  const [runFailure, setRunFailure] = useState<string | null>(null)
  // Keyed by the Batch Extraction that reported them, so a stale run's failures
  // are never shown against a different batch's members.
  const [memberFailures, setMemberFailures] = useState<{
    batchExtractionId: string
    failures: ReadonlyMap<string, string>
  } | null>(null)
  const [schemas, setSchemas] = useState<Read<ExtractionSchemas>>({
    value: null,
    failure: null,
  })
  const [schemaRevisionId, setSchemaRevisionId] = useState('')
  const [chosenSchema, setChosenSchema] = useState<SchemaRevision | null>(null)
  const [strategy, setStrategy] = useState<ExtractionStrategy>('ARTICLE')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [filter, setFilter] = useState('')
  const opening = useRef(false)
  const historyGeneration = useRef(0)
  const acceptSuggestedBatch = useRef<
    (opened: Awaited<ReturnType<typeof openBatchExtraction>>) => void
  >(() => {})
  const [suggestion, sendSuggestion] = useMachine(
    batchSchemaSuggestionMachine,
    {
      input: {
        projectContextId,
        merge: mergeBatchSchemaSuggestions,
        confirm: confirmBatchSchemaSuggestion,
        open: (request) => openBatchExtraction(request),
        onOpened: (opened) => acceptSuggestedBatch.current(opened),
      },
    },
  )

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
    sendSuggestion({
      type: 'selection.changed',
      projectContextId,
      sourceDocumentIds: [...selected],
    })
  }, [projectContextId, selected, sendSuggestion])

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

  const batchList = batches.value ?? []
  const openBatch =
    batchList.find((batch) => batch.batchExtractionId === openBatchId) ?? null
  const openMemberFailures =
    openBatch &&
    memberFailures?.batchExtractionId === openBatch.batchExtractionId
      ? memberFailures.failures
      : null

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
      // Members that never reached a terminal write are not stored anywhere, so
      // this response is the only place they are ever reported. Say so here,
      // where the researcher lands, and again on each member.
      setMemberFailures({
        batchExtractionId: batch.batchExtractionId,
        failures: new Map(
          opened.memberFailures.map((failure) => [
            failure.sourceDocumentId,
            failure.message,
          ]),
        ),
      })
      setRunFailure(
        opened.memberFailures.length
          ? didNotRunSentence(
              opened.memberFailures.map((failure) =>
                documentName(failure.sourceDocumentId),
              ),
            )
          : null,
      )
    },
    [documentName],
  )
  useEffect(() => {
    acceptSuggestedBatch.current = acceptOpenedBatch
  }, [acceptOpenedBatch])

  const suggestFields = () => {
    if (selected.size === 0 || overSelectionLimit) return
    sendSuggestion({ type: 'suggestion.requested' })
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

  const updateSuggestedNode = (
    id: string,
    update: (node: SchemaNode) => SchemaNode,
  ) => {
    updateSuggestedDefinition((definition) => ({
      ...definition,
      schemaNodes: definition.schemaNodes.map((node) =>
        node.id === id ? update(node) : node,
      ),
    }))
  }

  const openExistingSchemaBatch = async () => {
    if (opening.current) return
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
      if (!batchSchemaSuggestionIsValid(suggestion.context.proposal)) return
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
  const overSelectionLimit = selected.size > BATCH_EXTRACTION_SELECTION_LIMIT
  const suggestedFields = suggestion.context.proposal
  const suggestingFields = suggestion.matches('suggesting')
  const preparingSuggestedBatch =
    suggestion.matches('confirming') || suggestion.matches('opening')
  const openingAnyBatch = openingBatch || preparingSuggestedBatch
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
            onClick={() => setScreen('prepare')}
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
                    setSchemaRevisionId(event.target.value)
                    clearSuggestedFields()
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
                className="mb-5 rounded-md border border-line bg-line/10 p-3"
                aria-label="Extraction Schema fields"
              >
                <p className="text-[11px] leading-snug text-ink-muted">
                  {chosenSchema.recordDescription}
                </p>
                {/* ponytail: top-level fields only — an object or array field
                    shows its name and type, not its children. Render nested
                    fields if researchers need to see inside them. */}
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {chosenSchema.schemaNodes.map((node) => (
                    <li
                      className="rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] text-ink"
                      key={node.id}
                    >
                      {node.name}
                      <span className="ml-1.5 text-ink-faint">{node.type}</span>
                    </li>
                  ))}
                </ul>
              </section>
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
            {schemaRevisionId === SUGGEST_SCHEMA && (
              <section
                className="mt-4 space-y-3 border-t border-line pt-4"
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
                          onClick={suggestFields}
                        >
                          Try again
                        </Button>
                      )}
                    </div>
                    {suggestion.context.failure.code ===
                      'source_suggestion_failed' && (
                      <ul className="space-y-1 text-[11px] text-danger">
                        {suggestion.context.failure.details.failures.map(
                          (failure) => (
                            <li key={failure.sourceDocumentId}>
                              {documentName(failure.sourceDocumentId)}:{' '}
                              {sourceSuggestionFailureLabels[failure.code]}
                            </li>
                          ),
                        )}
                      </ul>
                    )}
                  </div>
                )}
                {suggestedFields?.status === 'heterogeneous' && (
                  <div className="space-y-2">
                    <p className="text-xs text-ink-muted">
                      No reliable common field set was found. Choose an existing
                      Extraction Schema, change the selection, or start blank.
                    </p>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={preparingSuggestedBatch}
                      onClick={() =>
                        sendSuggestion({
                          type: 'proposal.changed',
                          definition: {
                            recordDescription:
                              'One record from each selected Source Document.',
                            schemaNodes: [],
                          },
                        })
                      }
                    >
                      Start with blank fields
                    </Button>
                  </div>
                )}
                {suggestedFields?.status === 'ready' && (
                  <div className="space-y-3">
                    <label className="block text-[11px] font-semibold text-ink-muted">
                      Record description
                      <input
                        className={`${control} mt-1 block w-full font-normal`}
                        value={suggestedFields.recordDescription}
                        disabled={preparingSuggestedBatch}
                        onChange={(event) =>
                          updateSuggestedDefinition((definition) => ({
                            ...definition,
                            recordDescription: event.target.value,
                          }))
                        }
                      />
                    </label>
                    {suggestedFields.schemaNodes.map((node) => {
                      const coverage = suggestedFields.coverage.find(
                        (field) => field.nodeId === node.id,
                      )
                      return (
                        <div className="flex items-center gap-2" key={node.id}>
                          <input
                            aria-label={`Field ${node.name}`}
                            className={`${control} min-w-0 flex-1`}
                            value={node.name}
                            disabled={preparingSuggestedBatch}
                            onChange={(event) =>
                              updateSuggestedNode(node.id, (current) => ({
                                ...current,
                                name: event.target.value,
                              }))
                            }
                          />
                          {coverage && (
                            <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">
                              {coverage.present}/{coverage.total}
                            </span>
                          )}
                          <button
                            className="shrink-0 text-[11px] font-semibold text-danger disabled:opacity-50"
                            type="button"
                            disabled={preparingSuggestedBatch}
                            onClick={() =>
                              updateSuggestedDefinition((definition) => ({
                                ...definition,
                                schemaNodes: definition.schemaNodes.filter(
                                  (field) => field.id !== node.id,
                                ),
                              }))
                            }
                          >
                            Remove
                          </button>
                        </div>
                      )
                    })}
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={preparingSuggestedBatch}
                      onClick={() =>
                        updateSuggestedDefinition((definition) => ({
                          ...definition,
                          schemaNodes: [
                            ...definition.schemaNodes,
                            {
                              id: crypto.randomUUID(),
                              name: `field_${definition.schemaNodes.length + 1}`,
                              type: 'string',
                            },
                          ],
                        }))
                      }
                    >
                      Add field
                    </Button>
                    <div>
                      <p className="mb-1 text-[11px] font-semibold text-ink-muted">
                        Merged schema preview
                      </p>
                      <pre
                        aria-label="Merged schema preview"
                        className="max-h-64 overflow-auto rounded-md border border-line bg-line/10 p-3 text-[11px] leading-relaxed text-ink"
                      >
                        {JSON.stringify(
                          {
                            recordDescription:
                              suggestedFields.recordDescription,
                            schemaNodes: suggestedFields.schemaNodes,
                          },
                          (key, value) => (key === 'id' ? undefined : value),
                          2,
                        )}
                      </pre>
                    </div>
                  </div>
                )}
              </section>
            )}
            <div className="mt-4 flex justify-end">
              <Button
                variant="primary"
                size="md"
                disabled={
                  selected.size === 0 ||
                  (schemaRevisionId === SUGGEST_SCHEMA
                    ? !batchSchemaSuggestionIsValid(suggestedFields)
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
            </div>
            <ul className="space-y-1" aria-label="Batch Extraction members">
              {openBatch.members.map((member) => {
                const status = memberStatus(
                  member,
                  openMemberFailures?.get(member.sourceDocumentId),
                )
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
