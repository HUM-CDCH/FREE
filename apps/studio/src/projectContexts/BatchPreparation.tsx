import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { recordScopeOf, strategyOf } from 'extraction/schema'
import {
  BATCH_EXTRACTION_SELECTION_LIMIT,
  PILOT_BATCH_SELECTION_LIMIT,
  type BatchExtraction,
} from '../../shared/batchExtraction.contract'
import type { BatchSchemaSuggestion } from '../../shared/batchSchemaSuggestion.contract'
import type { ExtractionStrategy } from '../../shared/extraction.contract'
import type { SchemaRevision } from '../../shared/schemaRevision.contract'
import { requestModelKeyResend } from '../auth/authenticatedFetch'
import { SavedMethodSummary } from '../SavedMethodSummary'
import { savedMethodFor, type useSavedMethod } from '../savedMethod'
import SchemaPanel from '../SchemaPanel'
import SchemaConversation from '../SchemaConversation'
import { useSchemaChat } from '../useSchemaChat'
import { getSchemaRevision, listExtractionSchemas } from '../schemaRevisions'
import { sourceCoverageNotice, UNCOMBINED_NOTICE } from '../sourceCoverageNotice'
import { Button } from '../ui'
import { useDurableCurrentSchemaRevision } from '../useCurrentSchemaRevision'
import {
  applyBatchSchemaSuggestion,
  BatchRequestError,
  createBatchSchemaSuggestion,
  listBatchSchemaSuggestions,
  openBatchExtraction,
  retryBatchSchemaSuggestion,
  stopBatchSchemaSuggestion,
} from './batchExtractions'

export type PreparationKind = 'pilot' | 'batch' | 'custom'
type SourceDocument = { sourceDocumentId: string; name: string; pageCount: number | null }
type SavedMethod = ReturnType<typeof useSavedMethod>
type OpenedBatch = Awaited<ReturnType<typeof openBatchExtraction>>
type ExtractionSchemas = Awaited<ReturnType<typeof listExtractionSchemas>>

/** The template select's value while fields are being suggested for the selection. */
const SUGGEST = '__suggest_common_fields__'
const STRATEGY_HELP = 'Article: one object for the whole document. Catalog: a collection of records.'
const control =
  'rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink outline-none focus-visible:border-accent'

/** Refusals said with the saved-method summary: the saved advanced settings changed after it was shown, or the
 *  strategy is not the schema's saved Article/Catalog scope. Nothing started. */
const METHOD_REFUSALS: ReadonlySet<string> = new Set([
  'method_changed',
  'catalog_migration_required',
  'record_scope_required',
  'record_scope_mismatch',
])

function failureText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

const active = (operation: { executionStatus: string }) =>
  operation.executionStatus === 'QUEUED' || operation.executionStatus === 'RUNNING'

/** True while mounted: a continuation that outlives its screen (a project switch, Back) must not act on the next one. */
function useMounted() {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return mounted
}

/** Source Documents already reviewed under this Schema Revision in a prior Batch Extraction: a Run of the exact same
 *  selection and method reuses them (batch-extraction-pilot-reuse). */
function alreadyReviewed(batches: readonly BatchExtraction[], schemaRevisionId: string | null): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const batch of batches)
    if (batch.schemaRevisionId === schemaRevisionId)
      for (const member of batch.members) if (member.currentReview) ids.add(member.sourceDocumentId)
  return ids
}

function sameSelection(suggestion: BatchSchemaSuggestion, selected: ReadonlySet<string>): boolean {
  return (
    suggestion.sourceKind === 'DOCUMENTS' &&
    suggestion.sources.length === selected.size &&
    suggestion.sources.every((source) => selected.has(source.sourceDocumentId))
  )
}

/**
 * The preparation screen: Source Documents, the template they run with, and Run. A template is always an ordinary
 * Extraction Schema; suggesting fields for the selection is an operation whose settled result is saved as one and then
 * opened like any other. Mounted once per preparation, so every read here is fresh.
 */
export function BatchPreparation({
  projectContextId,
  sourceDocuments,
  batches,
  kind,
  initialSchemaRevisionId,
  initialSelection,
  saved,
  onCancel,
  onOpened,
}: {
  projectContextId: string
  sourceDocuments: readonly SourceDocument[]
  batches: readonly BatchExtraction[]
  kind: PreparationKind
  /** The Schema Revision a guided entry opens on; its schema is chosen when it is still that schema's current one. */
  initialSchemaRevisionId: string | null
  initialSelection: readonly string[]
  saved: SavedMethod
  onCancel(): void
  onOpened(opened: OpenedBatch): void
}) {
  const guided = kind !== 'custom'
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(initialSelection))
  const [filter, setFilter] = useState('')
  const [schemas, setSchemas] = useState<{ value: ExtractionSchemas | null; failure: string | null }>({ value: null, failure: null })
  const [schemasReload, setSchemasReload] = useState(0)
  // '' until chosen, SUGGEST while suggesting, else the chosen Extraction Schema.
  const [templateId, setTemplateId] = useState('')
  const [revision, setRevision] = useState<SchemaRevision | null>(null)
  const suggestions = useSuggestions(projectContextId)
  // A previous editor or another tab may have appended revisions since this list was read. Never mount a new
  // controller from that cached head: refresh the list before opening the selection, including a saved suggestion.
  const chooseTemplate = useCallback((id: string) => {
    setRevision(null)
    setTemplateId(id)
    if (id !== SUGGEST) {
      setSchemas({ value: null, failure: null })
      setSchemasReload(value => value + 1)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    listExtractionSchemas(projectContextId, undefined, controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return
        setSchemas({ value, failure: null })
        // A named revision a later save replaced opens nothing: the researcher chooses, rather than run another schema.
        const initial = initialSchemaRevisionId
          ? value.find((schema) => schema.currentRevision?.schemaRevisionId === initialSchemaRevisionId)
          : value.find((schema) => schema.currentRevision)
        setTemplateId((current) => current || initial?.extractionSchemaId || '')
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setSchemas({ value: null, failure: failureText(error, 'Templates could not be read.') })
      },
    )
    return () => controller.abort()
  }, [projectContextId, initialSchemaRevisionId, schemasReload])

  const chosenSchema = schemas.value?.find((schema) => schema.extractionSchemaId === templateId) ?? null
  const currentRevisionId = chosenSchema?.currentRevision?.schemaRevisionId ?? null
  // The chosen schema's current revision, the editor's starting point. A failed read leaves it unopened.
  useEffect(() => {
    if (!currentRevisionId) return
    const controller = new AbortController()
    getSchemaRevision(projectContextId, templateId, currentRevisionId, controller.signal).then(
      (read) => {
        if (!controller.signal.aborted) setRevision(read)
      },
      () => {},
    )
    return () => controller.abort()
  }, [projectContextId, templateId, currentRevisionId])
  const openRevision = revision?.extractionSchemaId === templateId ? revision : null

  // The suggestion for this selection; once it is saved, its template opens. One the list does not hold yet is re-read.
  const suggestion = templateId === SUGGEST
    ? (suggestions.value ?? []).find((candidate) => sameSelection(candidate, selected)) ?? null
    : null
  const savedSchemaId = suggestion?.savedSchema?.extractionSchemaId ?? null
  useEffect(() => {
    if (!savedSchemaId) return
    // Adopting the saved template is one step the server's answer takes, wherever that answer came from (this page's
    // apply, or a list read after another tab's); from then on it is the chosen template, whatever the selection does.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    chooseTemplate(savedSchemaId)
  }, [savedSchemaId, chooseTemplate])
  // The template's own provenance: the suggestion it was saved from, if any.
  const savedFrom = (suggestions.value ?? []).find((candidate) => candidate.savedSchema?.extractionSchemaId === templateId) ?? null

  const documentName = (sourceDocumentId: string) =>
    sourceDocuments.find((document) => document.sourceDocumentId === sourceDocumentId)?.name
  const overSelectionLimit = selected.size > BATCH_EXTRACTION_SELECTION_LIMIT
  const reviewed = alreadyReviewed(batches, openRevision?.schemaRevisionId ?? null)
  const filtered = sourceDocuments.filter((document) =>
    document.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  const allSelected = sourceDocuments.length > 0 && sourceDocuments.every((document) => selected.has(document.sourceDocumentId))

  const templateSelect = (
    <label className="text-[11px] font-semibold text-ink-muted">
      Extraction Template
      <select
        className={`${control} mt-1 block w-full font-normal`}
        value={templateId}
        // The workflow's pilot and batch run its Current Schema Revision; another schema is a custom run.
        disabled={schemas.value === null || (guided && templateId !== '')}
        onChange={(event) => chooseTemplate(event.target.value)}
      >
        {schemas.value ? (
          <>
            <option value="" disabled>Select an Extraction Template</option>
            {schemas.value.flatMap((schema) => schema.currentRevision
              ? [<option key={schema.extractionSchemaId} value={schema.extractionSchemaId}>
                  {schema.name} · Template Revision {schema.currentRevision.revisionNumber}
                </option>]
              : [])}
            {/* Suggesting a schema here skips the workflow's schema steps: a custom run only. */}
            {!guided && <option value={SUGGEST}>Suggest fields from selected sources</option>}
          </>
        ) : (
          <option value="">{schemas.failure ? 'Templates unavailable' : 'Loading templates…'}</option>
        )}
      </select>
    </label>
  )

  return (
    <>
      {kind === 'pilot' && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface-muted px-3 py-2">
          <p className="text-[11px] leading-snug text-ink-muted">
            Try your template on 2-3 documents first — it's faster to catch a template issue now than after running
            the whole collection.
          </p>
          <button
            type="button"
            className="shrink-0 text-[11px] font-semibold text-ink-muted underline decoration-dotted underline-offset-2 outline-none hover:text-ink hover:no-underline"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      )}
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-xs font-bold text-ink">Source Documents</h3>
          <p className="text-[11px] text-ink-faint">{selected.size} selected</p>
        </div>
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto sm:flex-nowrap">
          <Button
            variant="secondary"
            disabled={sourceDocuments.length === 0}
            onClick={() => setSelected(allSelected ? new Set() : new Set(sourceDocuments.map((document) => document.sourceDocumentId)))}
          >
            {allSelected ? 'Unselect all' : 'Select all'}
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
        <p className="py-6 text-center text-xs text-ink-muted [overflow-wrap:anywhere]">
          {sourceDocuments.length === 0
            ? 'No Source Documents yet. Add Source Documents on the Sources tab.'
            : `No Source Documents match “${filter}”.`}
        </p>
      ) : (
        <ul className="mb-5 space-y-1">
          {filtered.map((document) => (
            <li key={document.sourceDocumentId}>
              <label className="flex cursor-pointer items-center gap-3 rounded-md px-1 py-3 hover:bg-line/20">
                <input
                  className="size-3.5 accent-accent"
                  type="checkbox"
                  checked={selected.has(document.sourceDocumentId)}
                  onChange={() => setSelected((current) => {
                    const next = new Set(current)
                    if (!next.delete(document.sourceDocumentId)) next.add(document.sourceDocumentId)
                    return next
                  })}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="block min-w-0 truncate text-xs font-semibold text-ink" title={document.name}>
                      {document.name}
                    </span>
                    {reviewed.has(document.sourceDocumentId) && (
                      <span
                        className="shrink-0 rounded-full bg-green-soft px-1.5 py-0.5 text-[10px] font-semibold text-green"
                        title="This Source Document has a reviewed result under this Template Revision. Re-running the exact same selection and method reuses it; a different selection extracts it again."
                      >
                        Reviewed under this Revision
                      </span>
                    )}
                  </span>
                  {document.pageCount !== null && (
                    <span className="block text-[11px] text-ink-faint">
                      {document.pageCount} {document.pageCount === 1 ? 'page' : 'pages'}
                    </span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {overSelectionLimit && (
        <p className="mb-5 text-[11px] text-danger" role="alert">
          One Batch Extraction takes at most {BATCH_EXTRACTION_SELECTION_LIMIT} Source Documents.
        </p>
      )}
      {schemas.failure && (
        <p className="mb-3 text-[11px] text-danger [overflow-wrap:anywhere]" role="alert">{schemas.failure}</p>
      )}
      {openRevision && chosenSchema ? (
        <PreparedTemplate
          key={openRevision.extractionSchemaId}
          projectContextId={projectContextId}
          revision={openRevision}
          name={chosenSchema.name}
          selected={selected}
          saved={saved}
          templateSelect={templateSelect}
          provenance={savedFrom && (
            <SuggestionStatus
              suggestion={savedFrom}
              suggestions={suggestions}
              documentName={documentName}
              // Suggesting again re-reads the same Source Documents; its result is saved as another template, and this
              // one stays the researcher's.
              onSuggestAgain={() => {
                setSelected(new Set(savedFrom.sources.map((source) => source.sourceDocumentId)))
                setTemplateId(SUGGEST)
              }}
            />
          )}
          onOpened={onOpened}
        />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {templateSelect}
            <StrategySelect strategy={null} disabled />
          </div>
          {templateId === SUGGEST && (
            <section className="mb-5 space-y-3" aria-label="Suggested common fields">
              {selected.size > PILOT_BATCH_SELECTION_LIMIT && (
                <div className="rounded-md border border-line bg-surface-muted px-3 py-2">
                  <p className="text-[11px] leading-snug text-ink-muted">
                    These suggested fields start unstabilised, so they cannot run over {selected.size} Source
                    Documents yet. Pilot them on {PILOT_BATCH_SELECTION_LIMIT} or fewer documents, review the results and approve
                    the template for batch extraction before running the full collection.
                  </p>
                </div>
              )}
              <SuggestionStatus
                suggestion={suggestion}
                suggestions={suggestions}
                documentName={documentName}
                onRequest={selected.size === 0 || overSelectionLimit ? undefined : async () => {
                  suggestions.record(await createBatchSchemaSuggestion(projectContextId, [...selected]))
                }}
              />
            </section>
          )}
          <RunBar
            selectedCount={selected.size}
            blocker={selected.size === 0
              ? 'Select at least one Source Document.'
              : overSelectionLimit
                ? null
                : templateId === SUGGEST
                  ? 'Get the suggested fields ready first.'
                  : 'Choose an Extraction Template.'}
          />
        </>
      )}
    </>
  )
}

/** The project's Batch Schema Suggestions, re-read while one is at work and on focus. A response to this page's own
 *  request replaces the listed one; a list read started before it is then dropped. */
function useSuggestions(projectContextId: string) {
  const [read, setRead] = useState<{ value: BatchSchemaSuggestion[] | null; failure: string | null }>({ value: null, failure: null })
  const [reload, setReload] = useState(0)
  const generation = useRef(0)
  const pending = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    const requested = ++generation.current
    pending.current = true
    void listBatchSchemaSuggestions(projectContextId, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted && requested === generation.current) setRead({ value, failure: null })
      },
      (error: unknown) => {
        if (!controller.signal.aborted && requested === generation.current)
          setRead({ value: null, failure: failureText(error, 'Batch Template Suggestions could not be read.') })
      },
    ).finally(() => {
      pending.current = false
    })
    return () => controller.abort()
  }, [projectContextId, reload])
  const working = read.value?.some(active) ?? false
  useEffect(() => {
    const refresh = () => {
      if (!pending.current) setReload((value) => value + 1)
    }
    window.addEventListener('focus', refresh)
    const interval = working ? window.setInterval(refresh, 2_000) : undefined
    return () => {
      window.removeEventListener('focus', refresh)
      window.clearInterval(interval)
    }
  }, [working])
  // A background attempt that found no key reports model_key_required inside a 200 read, which authenticatedFetch's
  // 409 hook never sees: resend this page's keys once per such attempt, so the researcher's retry can succeed.
  const keysResentFor = useRef(new Set<string>())
  useEffect(() => {
    const keyless = (read.value ?? [])
      .filter((candidate) => candidate.failure?.code === 'model_key_required')
      .map((candidate) => `${candidate.batchSchemaSuggestionId}:${candidate.attempt}`)
      .filter((attempt) => !keysResentFor.current.has(attempt))
    if (keyless.length === 0) return
    for (const attempt of keyless) keysResentFor.current.add(attempt)
    requestModelKeyResend()
  }, [read.value])
  const record = useCallback((next: BatchSchemaSuggestion) => {
    generation.current += 1
    setRead((current) => ({
      value: [next, ...(current.value ?? []).filter((item) => item.batchSchemaSuggestionId !== next.batchSchemaSuggestionId)],
      failure: null,
    }))
  }, [])
  return { ...read, projectContextId, record }
}
type Suggestions = ReturnType<typeof useSuggestions>

/** The suggestion's own failure, as one line. A missing key is named, because the page has just resent its keys and a
 *  retry can succeed; any other failure is FREE's own sanitized message. */
function suggestionFailureText(failure: { code: string; message: string }): string {
  return failure.code === 'model_key_required' ? 'Model key not available' : failure.message
}

/**
 * A suggestion's progress and outcome, and the one action each state offers: request, Stop, Try again, or (once its
 * result is the open template) Suggest again. A settled result is saved as an Extraction Schema as soon as it is seen;
 * saving is idempotent, so another tab or a reload saves the same one.
 */
function SuggestionStatus({
  suggestion,
  suggestions,
  documentName,
  onRequest,
  onSuggestAgain,
}: {
  suggestion: BatchSchemaSuggestion | null
  suggestions: Suggestions
  documentName(sourceDocumentId: string): string | undefined
  onRequest?: () => Promise<void>
  onSuggestAgain?: () => void
}) {
  const mounted = useMounted()
  const [busy, setBusy] = useState<'requesting' | 'stopping' | 'retrying' | 'saving' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const { projectContextId, record } = suggestions
  const act = useCallback(async (step: NonNullable<typeof busy>, work: () => Promise<void>, fallback: string) => {
    setBusy(step)
    setFailure(null)
    try {
      await work()
    } catch (error) {
      if (mounted.current) setFailure(failureText(error, fallback))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [mounted])
  const working = suggestion !== null && active(suggestion)
  const unsaved = suggestion !== null && !working && suggestion.phase === 'READY' && suggestion.savedSchema === null
  // Saved once per attempt here; a failed save keeps its Try again.
  const savedAttempt = useRef<string | null>(null)
  const saveKey = suggestion && `${suggestion.batchSchemaSuggestionId}:${suggestion.attempt}`
  const save = useCallback(() => {
    if (!suggestion) return
    void act('saving', async () => {
      record(await applyBatchSchemaSuggestion(projectContextId, suggestion.batchSchemaSuggestionId))
    }, 'The suggested fields could not be saved.')
  }, [act, projectContextId, record, suggestion])
  useEffect(() => {
    if (!unsaved || savedAttempt.current === saveKey) return
    savedAttempt.current = saveKey
    save()
  }, [save, saveKey, unsaved])

  // `then` follows the recorded response, so what it shows already reads the new attempt.
  const retry = (then?: () => void) => suggestion && void act('retrying', async () => {
    record(await retryBatchSchemaSuggestion(projectContextId, suggestion.batchSchemaSuggestionId, suggestion.attempt))
    then?.()
  }, 'The suggestion could not be regenerated.')
  const notices = suggestion?.phase === 'READY' || suggestion?.phase === 'HETEROGENEOUS'
    ? (suggestion.sourceCoverage ?? []).flatMap(({ sourceDocumentId, sourceCoverage, combined }) => {
        const text = [sourceCoverage && sourceCoverageNotice(sourceCoverage), combined ? null : UNCOMBINED_NOTICE]
          .filter((statement) => statement).join(' ')
        return text ? [{ sourceDocumentId, text: `${documentName(sourceDocumentId) ?? 'A removed Source Document'}: ${text}` }] : []
      })
    : []
  const shownFailure = suggestion?.failure ? suggestionFailureText(suggestion.failure) : failure

  if (suggestion === null)
    return (
      <div className="space-y-2">
        <Button size="sm" disabled={!onRequest || busy !== null}
          onClick={() => onRequest && void act('requesting', onRequest, 'Common fields could not be suggested.')}>
          Suggest common fields
        </Button>
        {(failure || suggestions.failure) && (
          <p className="text-[11px] text-danger [overflow-wrap:anywhere]" role="alert">{failure ?? suggestions.failure}</p>
        )}
      </div>
    )
  return (
    <div className="mb-3 space-y-2">
      {(working || busy === 'requesting' || busy === 'retrying') && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-ink-muted" aria-busy="true">Suggesting common fields…</p>
          {working && (
            <Button size="sm" variant="danger" disabled={busy === 'stopping'}
              onClick={() => void act('stopping', async () => {
                record(await stopBatchSchemaSuggestion(projectContextId, suggestion.batchSchemaSuggestionId))
              }, 'The suggestion could not be stopped.')}>
              {busy === 'stopping' ? 'Stopping…' : 'Stop'}
            </Button>
          )}
        </div>
      )}
      {busy === 'saving' && <p className="text-xs text-ink-muted" aria-busy="true">Saving the suggested fields…</p>}
      {shownFailure && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 text-[11px] text-danger [overflow-wrap:anywhere]" role="alert">{shownFailure}</p>
          {busy === null && (suggestion.executionStatus === 'FAILED' || unsaved) && (
            <Button size="sm" disabled={suggestion.sources.length === 0 && !unsaved}
              onClick={unsaved && !suggestion.failure ? save : () => retry()}>
              Try again
            </Button>
          )}
        </div>
      )}
      {notices.map((notice) => (
        <p key={notice.sourceDocumentId} className="text-[11px] text-ink-muted [overflow-wrap:anywhere]" role="note">{notice.text}</p>
      ))}
      {suggestion.phase === 'HETEROGENEOUS' && !working && (
        <p className="text-xs text-ink-muted">
          No reliable common field set was found. Choose an existing Extraction Template or change the selection.
        </p>
      )}
      {onSuggestAgain && !working && suggestion.sources.length > 0 && (
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => retry(onSuggestAgain)}>
          Suggest again from these Source Documents
        </Button>
      )}
    </div>
  )
}

function StrategySelect({ strategy, disabled, blockedReason, onChange }: {
  strategy: ExtractionStrategy | null
  disabled: boolean
  blockedReason?: string | null
  onChange?: (strategy: ExtractionStrategy) => void
}) {
  const unchosen = !disabled && strategy === null
  return (
    <label className="text-[11px] font-semibold text-ink-muted" title={STRATEGY_HELP}>
      Extraction Strategy
      <select
        className={`${control} mt-1 block w-full font-normal`}
        aria-label="Batch extraction strategy"
        aria-describedby={blockedReason || unchosen ? 'batch-extraction-strategy-help' : undefined}
        value={strategy ?? ''}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.value as ExtractionStrategy)}
      >
        {strategy === null && <option value="" disabled>Choose…</option>}
        <option value="ARTICLE">Article</option>
        <option value="CATALOG">Catalog</option>
      </select>
      {(blockedReason || unchosen) && (
        <span id="batch-extraction-strategy-help" className="mt-1 block font-normal">{blockedReason ?? STRATEGY_HELP}</span>
      )}
    </label>
  )
}

/** Run, with what stops it said beside it, so a disabled Run is never a mystery. */
function RunBar({ selectedCount, blocker, opening = false, onRun }: {
  selectedCount: number
  blocker: string | null
  opening?: boolean
  onRun?: () => void
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
      {blocker && !opening && (
        <p className="min-w-0 text-[11px] leading-snug text-ink-muted [overflow-wrap:anywhere]" role="status">{blocker}</p>
      )}
      <Button variant="positive" size="md" disabled={!onRun || opening} onClick={onRun}>
        {opening ? 'Opening…' : 'Run'} {selectedCount} Source Document{selectedCount === 1 ? '' : 's'}
      </Button>
    </div>
  )
}

/**
 * One chosen template: its ordinary durable editor, its Article/Catalog scope and Run. Owning the editor's controller
 * here makes Run bind to what it saved: Run waits for the pending save and admits the acknowledged revision, whose
 * scope decides the strategy. Keyed by Extraction Schema, so another template is another editor.
 */
function PreparedTemplate({
  projectContextId,
  revision,
  name,
  selected,
  saved,
  templateSelect,
  provenance,
  onOpened,
}: {
  projectContextId: string
  revision: SchemaRevision
  name: string
  selected: ReadonlySet<string>
  saved: SavedMethod
  templateSelect: ReactNode
  provenance: ReactNode
  onOpened(opened: OpenedBatch): void
}) {
  const mounted = useMounted()
  const schema = useDurableCurrentSchemaRevision({ projectContextId, extractionSchema: revision })
  const chat = useSchemaChat({ schema })
  const snap = useSyncExternalStore(schema.subscribe, schema.snapshot)
  const [opening, setOpening] = useState(false)
  const openingRef = useRef(false)
  const [refusal, setRefusal] = useState<{ message: string; code: string | null } | null>(null)
  const acknowledged = snap.save?.acknowledged ?? revision
  // Saves append revisions, which start unstabilised: only the revision this editor opened on carries an approval, and
  // only while nothing is waiting to replace it.
  const unchanged = acknowledged.schemaRevisionId === revision.schemaRevisionId && (snap.save?.status ?? 'saved') === 'saved'
  const stabilisedAt = unchanged ? revision.stabilisedAt : null
  const strategy = snap.recordScope === null ? null : strategyOf(snap.recordScope)
  const saveStatus = snap.save?.status
  const methodConflict = refusal?.code && METHOD_REFUSALS.has(refusal.code) ? refusal.message : null
  const collectionGate = selected.size > PILOT_BATCH_SELECTION_LIMIT && stabilisedAt === null
  const overSelectionLimit = selected.size > BATCH_EXTRACTION_SELECTION_LIMIT
  const blocker = snap.useBlockedReason ?? (selected.size === 0
    ? 'Select at least one Source Document.'
    : overSelectionLimit
      ? null // Already said beside the selection.
      : saved.state.status === 'loading'
        ? 'Loading your extraction settings…'
        : saved.state.status === 'error'
          ? `Your extraction settings could not be read: ${saved.state.message}`
          : collectionGate
            ? `Approve the template in the chat to run more than ${PILOT_BATCH_SELECTION_LIMIT} Source Documents.`
            : strategy === null
              ? 'Choose Article or Catalog.'
              // Run waits for the editor's save; a failed or conflicting one blocks it until the editor recovers.
              : saveStatus === 'error' || saveStatus === 'conflict'
                ? 'The template has unsaved changes: resolve them above first.'
                : null)

  const run = async () => {
    if (openingRef.current || saved.state.status !== 'ready') return
    const savedState = saved.state
    openingRef.current = true
    setOpening(true)
    setRefusal(null)
    try {
      const admitted = await schema.prepareUse()
      // The saved revision's own scope decides what runs; admission refuses any other.
      if (admitted.recordScope === null) throw new Error('Choose Article or Catalog before running.')
      const runStrategy = strategyOf(admitted.recordScope)
      const opened = await openBatchExtraction({
        projectContextId,
        schemaRevisionId: admitted.schemaRevisionId,
        strategy: runStrategy,
        sourceDocumentIds: [...selected],
        method: savedMethodFor(savedState, runStrategy, null),
      })
      onOpened(opened)
    } catch (error) {
      if (mounted.current)
        setRefusal({
          message: failureText(error, 'The Batch Extraction could not be opened.'),
          code: error instanceof BatchRequestError ? error.code ?? null : null,
        })
    } finally {
      openingRef.current = false
      if (mounted.current) setOpening(false)
    }
  }

  const saveFailure = saveStatus === 'error' ? snap.save?.error?.message ?? 'The template could not be saved.' : null
  return (
    <>
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {templateSelect}
        <StrategySelect
          strategy={strategy}
          disabled={opening || snap.editingBlockedReason !== null}
          blockedReason={snap.editingBlockedReason}
          // A scope change is a schema change: the editor appends a revision with it.
          onChange={(next) => schema.setRecordScope(recordScopeOf(next))}
        />
      </div>
      <div className="mb-3">
        {strategy !== null && (
          <SavedMethodSummary saved={saved.state} conflict={methodConflict}
            method={saved.state.status === 'ready' ? savedMethodFor(saved.state, strategy, null) : null}
            onRefresh={() => { setRefusal(null); void saved.refresh() }} />
        )}
      </div>
      {/* A small, unstabilised selection needs no banner: the pilot banner covers why, and Cancel the way out. */}
      {(stabilisedAt || selected.size > PILOT_BATCH_SELECTION_LIMIT) && (
        <div className="mb-3 rounded-md border border-line bg-surface-muted px-3 py-2">
          <p className="text-[11px] leading-snug text-ink-muted">
            {stabilisedAt
              ? 'This template is approved for batch extraction — the full collection is unlocked.'
              : `This template isn't approved for batch extraction yet: a run over ${PILOT_BATCH_SELECTION_LIMIT} Source Documents needs an approved template. Pilot it on ${PILOT_BATCH_SELECTION_LIMIT} or fewer documents, review the results, then approve it in the chat.`}
          </p>
        </div>
      )}
      {provenance}
      <section
        className="mb-5 flex h-[32rem] flex-col overflow-hidden rounded-md border border-line bg-surface"
        aria-label="Extraction Template fields"
        aria-busy={opening}
        inert={opening ? true : undefined}
      >
        <SchemaPanel
          schema={schema}
          proposalReview={chat.proposalReview}
          revealed={chat.revealed}
          // Clear keeps the record description and empties the fields, saved at once.
          onClearDraft={async () => {
            if (schema.clearDraft('Cleared fields').ok) await schema.flush()
          }}
          sourceDocumentName={`${name} · Template Revision ${acknowledged.revisionNumber}`}
        />
        <SchemaConversation chat={chat} />
      </section>
      {saveFailure && (
        <div className="-mt-3 mb-5 flex flex-wrap items-center gap-2">
          <p className="min-w-0 text-[11px] text-danger [overflow-wrap:anywhere]" role="alert">{saveFailure}</p>
          {/* A flush retries the failed save with the latest fields and scope; a new failure shows here again. */}
          <Button onClick={() => void schema.flush().catch(() => undefined)}>Retry save</Button>
        </div>
      )}
      {refusal && !methodConflict && (
        <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
          <p className="min-w-0 text-[11px] leading-snug text-danger [overflow-wrap:anywhere]" role="alert">{refusal.message}</p>
          {refusal.code === 'schema_not_stabilised' && (
            <p className="text-[11px] leading-snug text-ink-muted">Approve the template in the chat, then run again.</p>
          )}
        </div>
      )}
      <RunBar selectedCount={selected.size} blocker={blocker} opening={opening}
        onRun={blocker === null && !overSelectionLimit && saved.state.status === 'ready' ? () => void run() : undefined} />
    </>
  )
}
