import {
  schemaDefinitionSchema,
  enumerateFieldPaths,
  mkId,
  templateToSchemaDefinition,
  type RecordScope,
  type SchemaDefinition,
  type SchemaNode,
} from 'extraction/schema'
import type {
  SchemaRevision,
  SchemaRevisionSummary,
} from '../shared/schemaRevision.contract'
import {
  createSchemaSaveCoordinator,
  type AcknowledgedSchemaRevision,
  type SchemaSaveCoordinator,
  type SchemaSaveState,
} from './schemaSaveCoordinator'
import { newSchemaTreeViolation } from './schemaEditorTree'
import { sameSchemaDefinition } from './schemaDefinitionEquality'
import { SchemaRevisionConflictError } from './schemaRevisions'
import type { SchemaModelContext } from './api'
import type { SourceCoverage } from '../shared/schemaSuggestionSource.contract'

// ────────────────────────────────────────────────────────────────────────────
// Persistence port
// ────────────────────────────────────────────────────────────────────────────

/** Durable capabilities supplied by the application's revision adapter. A new schema has no first revision yet. */
export type SchemaEditorPersistence = {
  /** Omitted coverage inherits the saved revision's declaration; replacements declare their own. */
  edit(definition: SchemaDefinition, sourceCoverage?: SourceCoverage | null): void
  setRecordScope(recordScope: RecordScope): void
  extractionSchemaId(): string | null
  projectContextId(): string
  initialize(definition: SchemaDefinition, signal?: AbortSignal, sourceCoverage?: SourceCoverage | null, recordScope?: RecordScope): Promise<SchemaRevision>
  flush(): Promise<AcknowledgedSchemaRevision | null>
  saveState(): SchemaSaveState | null
  reloadCurrent(): AcknowledgedSchemaRevision | null
  modelContext(revision: PreparedSchema): SchemaModelContext
  listRevisions(limit: number, signal?: AbortSignal): Promise<SchemaRevisionSummary[]>
  getRevision(schemaRevisionId: string, signal?: AbortSignal): Promise<SchemaRevision>
  onChange(listener: () => void): () => void
  dispose(): void
}

export type PreparedSchema = Readonly<{
  extractionSchemaId: string
  schemaRevisionId: string
  recordScope: RecordScope | null
}>

/** Normalize externally supplied node trees defensively (stable unique ids). */
function withUniqueNodeIds(nodes: readonly SchemaNode[]): SchemaNode[] {
  const seen = new Set<string>()
  const visit = (node: SchemaNode): SchemaNode => {
    let id = node.id
    while (seen.has(id)) id = mkId()
    seen.add(id)
    return node.children === undefined
      ? { ...node, id }
      : { ...node, id, children: node.children.map(visit) }
  }
  return nodes.map(visit)
}

function normalizeSchemaDefinition(
  definition: SchemaDefinition,
): SchemaDefinition {
  return {
    recordDescription: definition.recordDescription,
    schemaNodes: withUniqueNodeIds(definition.schemaNodes),
  }
}

/**
 * Durability over Extraction Schema revisions. Wraps the save coordinator
 * (debounce → optimistic-conflict-checked append) as an internal detail; the
 * Extraction Schema id arrives with the first revision when the scope starts
 * without one.
 */
export function durableSchemaPersistence(options: {
  projectContextId: string
  initial: AcknowledgedSchemaRevision | null
  debounceMs?: number
  /** `sourceCoverage` or `recordScope` omitted: the new revision inherits its head's (see `SchemaEditorPersistence.edit`). */
  append(
    extractionSchemaId: string,
    expectedRevisionNumber: number,
    definition: SchemaDefinition,
    sourceCoverage?: SourceCoverage | null,
    recordScope?: RecordScope,
  ): Promise<SchemaRevision>
  initialize(
    definition: SchemaDefinition,
    signal?: AbortSignal,
    sourceCoverage?: SourceCoverage | null,
    recordScope?: RecordScope,
  ): Promise<SchemaRevision>
  reconcileInitialization?(): Promise<SchemaRevision | null>
  listRevisions(
    extractionSchemaId: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SchemaRevisionSummary[]>
  getRevision(
    extractionSchemaId: string,
    schemaRevisionId: string,
    signal?: AbortSignal,
  ): Promise<SchemaRevision>
}): SchemaEditorPersistence {
  let extractionSchemaId = options.initial?.extractionSchemaId ?? null
  let uncertainInitialization = false
  const listeners = new Set<() => void>()
  function notify() {
    for (const listener of listeners) listener()
  }
  // A wholesale replacement's declaration, held until a save carries it: the save engine may merge later edits into
  // that save, and those edits derive from the replacement. Adopting the server's head drops it.
  let replacement: { sourceCoverage: SourceCoverage | null } | null = null
  // One append binding per coordinator; the Extraction Schema id arrives with
  // the first revision when the scope starts without one.
  const appendCurrent = async (expected: number, definition: SchemaDefinition, recordScope?: RecordScope) => {
    if (extractionSchemaId === null) throw new Error('No durable template is open.')
    const carried = replacement
    const saved = await options.append(extractionSchemaId, expected, definition, carried?.sourceCoverage, recordScope)
    if (replacement === carried) replacement = null
    return saved
  }
  let coordinator: SchemaSaveCoordinator | null = options.initial
    ? createSchemaSaveCoordinator(options.initial, appendCurrent, options.debounceMs, notify)
    : null
  function attach(revision: SchemaRevision) {
    extractionSchemaId = revision.extractionSchemaId
    coordinator = createSchemaSaveCoordinator(revision, appendCurrent, options.debounceMs, notify)
  }
  return {
    modelContext(revision) {
      return { projectContextId: options.projectContextId, extractionSchemaId: revision.extractionSchemaId, schemaRevisionId: revision.schemaRevisionId }
    },
    extractionSchemaId() {
      return extractionSchemaId
    },
    projectContextId() {
      return options.projectContextId
    },
    async initialize(definition, signal, sourceCoverage, recordScope) {
      if (coordinator) throw new Error('A durable template is already open.')
      if (uncertainInitialization) {
        if (!options.reconcileInitialization) throw new Error('Reload the project to reconcile the uncertain template save.')
        const current = await options.reconcileInitialization()
        if (current) {
          if (!sameSchemaDefinition(current, definition)) throw new SchemaRevisionConflictError(current)
          attach(current); notify(); return current
        }
        uncertainInitialization = false
      }
      try {
        const revision = await options.initialize(definition, signal, sourceCoverage, recordScope)
        attach(revision); notify(); return revision
      } catch (error) { uncertainInitialization = true; throw error }
    },
    edit(definition, sourceCoverage) {
      if (!coordinator) return
      if (sourceCoverage !== undefined) replacement = { sourceCoverage }
      coordinator.edit(definition)
    },
    setRecordScope(recordScope) {
      coordinator?.setRecordScope(recordScope)
    },
    flush() {
      return coordinator ? coordinator.flush() : Promise.resolve(null)
    },
    saveState() {
      return coordinator ? coordinator.state : null
    },
    reloadCurrent() {
      replacement = null
      return coordinator?.reloadCurrent() ?? null
    },
    listRevisions(limit, signal) {
      if (extractionSchemaId === null) return Promise.resolve([])
      return options.listRevisions(extractionSchemaId, limit, signal)
    },
    getRevision(schemaRevisionId, signal) {
      if (extractionSchemaId === null)
        return Promise.reject(new Error('No durable template is open.'))
      return options.getRevision(extractionSchemaId, schemaRevisionId, signal)
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      coordinator?.dispose()
      coordinator = null
      listeners.clear()
    },
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Controller
// ────────────────────────────────────────────────────────────────────────────

export type SchemaMutationResult =
  | { ok: true }
  | { ok: false; reason: 'no-draft' }
  | { ok: false; reason: 'duplicate-name'; duplicateName: string }
  | { ok: false; reason: 'validation'; message: string }

export type SchemaProposalValidity = { ok: true } | { ok: false; reason: 'stale' | 'blocked'; message: string }
export type SchemaProposalHandle = {
  release(): void
  validity(): SchemaProposalValidity
  apply(mutator: (nodes: SchemaNode[]) => SchemaNode[], message: string): SchemaMutationResult | Exclude<SchemaProposalValidity, { ok: true }>
}

export type SchemaLocalInput = {
  id: symbol
  kind: 'field' | 'description' | 'json'
  value: string
  error: string | null
  stale: boolean
}
export type SchemaInputHandle = {
  update(value: string): void
  save(): boolean
  cancel(): void
}

export type SchemaEditorSnapshot = {
  /** What the editor body renders: ungenerated / producing / failed / editing. */
  input: SchemaLocalInput | null
  useBlockedReason: string | null
  editingBlockedReason: string | null
  view: 'empty' | 'generating' | 'failed' | 'editing'
  /** Generation can run while the acknowledged current draft stays mounted. */
  generating: boolean
  generationError: string | null
  /** A Stop whose server-side cancel failed: the generation may still be running and shows after a reload. */
  cancellationError: string | null
  /** Editor payload; null until the first generation or adoption. */
  draft: SchemaDefinition | null
  /** Increments for every whole-draft mutation, including description edits. */
  draftVersion: number
  /** Increments on whole-draft replacement and reset, invalidating gestures and local authority. */
  replacementVersion: number
  /** Durable save lifecycle; null before the first revision. */
  save: SchemaSaveState | null
  history: SchemaRevisionSummary[]
  /** Identity of the durable Extraction Schema once one exists. */
  extractionSchemaId: string | null
  /** Revision number the history drawer marks as Current. */
  currentRevisionNumber: number | undefined
  /**
   * The saved Schema Revision currently safe to use for Extraction. Null while
   * the visible editor draft differs from the acknowledged revision.
   */
  extractableSchemaRevisionId: string | null
  creatingFromRevisionId: string | null
  previewingRevisionId: string | null
  historicalPreview: SchemaRevision | null
  /** Source ranges the suggestion did not read. Accepted edits and recovered edits retain their saved provenance;
   * generation, import and History replacement declare their own provenance in persistence. */
  sourceCoverage: Extract<SourceCoverage, { complete: false }> | null
  /**
   * The definition's Article/Catalog choice (`document` / `records`): the one the next save declares, else the
   * acknowledged revision's; before the first revision, the choice its initialization will declare. Null when none is
   * chosen (a legacy revision or a new schema): a run needs a choice first.
   */
  recordScope: RecordScope | null
}

export type SchemaEditorController = {
  inputHandle(): SchemaInputHandle | null
  beginInput(kind: SchemaLocalInput['kind'], value: string, commit: (value: string) => SchemaDefinition): SchemaInputHandle
  prepareUse(): Promise<PreparedSchema>
  markProposal(base?: { draftVersion: number; schemaRevisionId: string | null }): SchemaProposalHandle
  snapshot(): SchemaEditorSnapshot
  subscribe(listener: () => void): () => void

  /** Runs a generation; `cancel` is what a user's Stop calls on the server, before the wait ends. The request resolves
   *  the template and may declare what of the source the model read. */
  generate(
    request: (signal: AbortSignal, declareSourceCoverage: (coverage: SourceCoverage | null) => void) => Promise<unknown>,
    options?: { cancel?: () => Promise<void> },
  ): Promise<void>
  cancelGeneration(): void
  /** The Project Context scope used to recover model operations after reload. */
  operationScope(): { projectContextId: string; extractionSchemaId: string | null }
  /** Saves a generation that finished while no tab waited for it, but only onto its base; true when it was saved. */
  restoreGeneration(template: unknown, baseSchemaRevisionId: string | null, sourceCoverage?: SourceCoverage | null): Promise<boolean>

  confirmDefinition(definition: SchemaDefinition): Promise<void>
  commit(
    mutator: (nodes: SchemaNode[]) => SchemaNode[],
    message: string,
  ): SchemaMutationResult
  /** Replace an accepted payload (including recovered session drafts). */
  replaceDraft(definition: SchemaDefinition, message: string): void
  clearDraft(message: string): SchemaMutationResult
  /** Choose Article (`document`) or Catalog (`records`): saved as a new revision's record scope, or declared by the
   *  first revision when none exists yet. */
  setRecordScope(recordScope: RecordScope): void

  /** Open a read-only Historical Schema Revision. */
  previewHistoricalRevision(schemaRevisionId: string): Promise<SchemaRevision>
  closeHistoricalPreview(): void
  createCurrentRevisionFromHistory(
    schemaRevisionId: string,
  ): Promise<AcknowledgedSchemaRevision>

  requestModelEdit(): Promise<SchemaModelContext>
  reloadCurrent(): AcknowledgedSchemaRevision | null
  flush(): Promise<AcknowledgedSchemaRevision | null>
  reset(): Promise<void>
  dispose(): void
}

export function createSchemaEditorController(
  persistence: SchemaEditorPersistence,
  options: {
    initialDraft?: SchemaDefinition | null
    /** Acknowledged revision number at construction, for history marking. */
    initialRevisionNumber?: number
    initialExtractableRevisionId?: string | null
    /** Seed for the drawer before the first async reload lands. */
    initialHistory?: SchemaRevisionSummary[]
    /** Routes each committed mutation message (toasts, logs). */
    onCommitMessage?: (message: string) => void
    historyLimit?: number
    /** The declaration saved with the revision the editor opens on (`initialDraft`); null when none was recorded. */
    initialSourceCoverage?: SourceCoverage | null
  } = {},
): SchemaEditorController {
  const historyLimit = options.historyLimit ?? 20
  let draft = options.initialDraft
    ? normalizeSchemaDefinition(options.initialDraft)
    : null
  let generating = false
  let generationError: string | null = null
  let cancellationError: string | null = null
  let generationAbort: AbortController | null = null
  let generationCancel: (() => Promise<void>) | null = null
  let extractableSchemaRevisionId =
    options.initialExtractableRevisionId ?? null
  let creatingFromRevisionId: string | null = null
  let previewingRevisionId: string | null = null
  let historicalPreview: SchemaRevision | null = null
  let history: SchemaRevisionSummary[] = options.initialHistory ?? []
  let historyAbort: AbortController | null = null
  let replacementVersion = 0
  let draftVersion = 0
  let sourceCoverage: SourceCoverage | null = options.initialSourceCoverage ?? null
  /** The choice held for the first revision while no durable revision exists. */
  let pendingRecordScope: RecordScope | null = null
  let disposed = false

  let input: SchemaLocalInput | null = null
  let activeHandle: SchemaInputHandle | null = null
  let inputBaseVersion = 0
  let inputEpoch = 0
  let inputBaseScope: RecordScope | null = null
  let preparing = false
  let proposal: symbol | null = null
  let previewRequest = 0
  function currentScope() {
    const save = persistence.saveState()
    return save ? save.recordScope : pendingRecordScope
  }
  function inputIsStale() {
    return input !== null && (input.stale || inputEpoch !== replacementVersion || inputBaseScope !== currentScope() || !draft || inputBaseVersion !== draftVersion)
  }
  function blocked() {
    return disposed ? 'This editor is closed.' : input ? 'Save or Cancel the open edit first.'
      : preparing ? 'The template is being prepared; try again.'
      : historicalPreview || previewingRevisionId ? 'Close the historical preview first.'
      : creatingFromRevisionId ? 'A historical revision is being applied.'
      : proposal ? 'Apply or discard the pending proposal first.' : null
  }
  function writable() {
    const reason = blocked()
    if (reason) throw new Error(reason)
  }
  const listeners = new Set<() => void>()
  let snapshot: SchemaEditorSnapshot = buildSnapshot()

  function buildSnapshot(): SchemaEditorSnapshot {
    const save = persistence.saveState() ?? null
    return {
      input: input ? { ...input, stale: inputIsStale() } : null,
      editingBlockedReason: blocked(),
      useBlockedReason: blocked() ?? (generating ? 'Wait for template generation.' : null),
      view:
        draft !== null
          ? 'editing'
          : generating
            ? 'generating'
            : generationError !== null
              ? 'failed'
              : 'empty',
      generating,
      generationError,
      cancellationError,
      draft,
      draftVersion,
      replacementVersion,
      save,
      history,
      extractionSchemaId: persistence.extractionSchemaId() ?? null,
      currentRevisionNumber:
        save?.acknowledged.revisionNumber ?? options.initialRevisionNumber,
      extractableSchemaRevisionId,
      creatingFromRevisionId,
      previewingRevisionId,
      historicalPreview,
      sourceCoverage:
        sourceCoverage?.complete === false
          ? sourceCoverage
          : null,
      recordScope: save ? save.recordScope : pendingRecordScope,
    }
  }
  function publish() {
    if (input && inputIsStale()) input = { ...input, stale: true }
    snapshot = buildSnapshot()
    for (const listener of listeners) listener()
  }

  function applyDraft(definition: SchemaDefinition, message: string) {
    // The draft has drifted from the acknowledged revision, so the accepted
    // result pin drops until the save engine acknowledges again.
    extractableSchemaRevisionId = null
    historicalPreview = null
    draft = definition
    draftVersion += 1
    publish()
    // An empty label is a caller that shows its own notice (the field-row delete and its Undo).
    if (message) options.onCommitMessage?.(message)
    persistence.edit(definition)
  }

  function definitionProblems(definition: SchemaDefinition): Map<string, string> {
    const parsed = schemaDefinitionSchema.safeParse(definition)
    if (parsed.success) return new Map()
    return new Map(parsed.error.issues.map(issue => {
      let current: unknown = definition
      const path = issue.path.map(part => {
        const value: unknown = current && typeof current === 'object' ? (current as Record<PropertyKey, unknown>)[part] : undefined
        current = value
        return typeof part === 'number' && value && typeof value === 'object' && 'id' in value ? String(value.id) : String(part)
      })
      return [`${path.join('/')}:${issue.code}:${issue.message}`, issue.message]
    }))
  }

  function mutate(mutator: (nodes: SchemaNode[]) => SchemaNode[], message: string): SchemaMutationResult {
    if (!draft) return { ok: false, reason: 'no-draft' }
    const nextNodes = mutator(draft.schemaNodes)
    const fields = enumerateFieldPaths(nextNodes)
    if (new Set(fields.map(field => field.id)).size !== fields.length) return { ok: false, reason: 'no-draft' }
    const violation = newSchemaTreeViolation(draft.schemaNodes, nextNodes)
    if (violation) return violation.reason === 'duplicate-name'
      ? { ok: false, reason: 'duplicate-name', duplicateName: violation.duplicateName }
      : { ok: false, reason: 'validation', message: violation.message }
    applyDraft(
      { recordDescription: draft.recordDescription, schemaNodes: nextNodes },
      message,
    )
    return { ok: true }
  }

  // Saves acknowledge → the extractable revision returns only when the visible
  // draft is exactly what persistence acknowledged; acknowledged revision
  // movement also refreshes history.
  let lastHistoryKey: string | null = null
  function reloadHistory() {
    historyAbort?.abort()
    const abort = new AbortController()
    historyAbort = abort
    persistence
      .listRevisions(historyLimit, abort.signal)
      .then((listed) => {
        if (abort.signal.aborted || disposed) return
        history = listed
        publish()
      })
      .catch(() => {
        if (abort.signal.aborted || disposed) return
        history = []
        publish()
      })
  }
  const historyKey = () =>
    `${persistence.extractionSchemaId() ?? ''}:${persistence.saveState()?.acknowledged.revisionNumber ?? ''}`
  const unsubscribeSave =
    persistence.onChange(() => {
      const save = persistence.saveState() ?? null
      if (save?.status === 'saved' && draft !== null) {
        // The server owns canonicalization. Once the coordinator reports saved,
        // its acknowledgement is the authoritative visible and extractable tree.
        if (!sameSchemaDefinition(draft, save.acknowledged)) {
          draft = normalizeSchemaDefinition(save.acknowledged)
          draftVersion += 1
        }
        extractableSchemaRevisionId = save.acknowledged.schemaRevisionId
      }
      publish()
      const key = historyKey()
      if (key !== lastHistoryKey) {
        lastHistoryKey = key
        reloadHistory()
      }
    })
  lastHistoryKey = historyKey()
  reloadHistory()

  function flushPersistence() {
    return persistence.flush()
  }

  /** Joins a generated candidate to the revision chain — onto the acknowledged head when a schema exists (the save
   *  coordinator's expected head), else as the first revision — with the generation's declaration, which the saved
   *  revision keeps. generate() and restoreGeneration() share it. */
  async function adoptGenerated(
    definition: SchemaDefinition,
    coverage: SourceCoverage | null,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const epoch = replacementVersion
    if ((persistence.extractionSchemaId() ?? null) !== null) {
      // Keep the acknowledged current draft mounted and extractable while the generated candidate joins the revision
      // chain. The save acknowledgement is the only event allowed to replace it.
      persistence.edit(definition, coverage)
      const revision = await flushPersistence()
      if (disposed || epoch !== replacementVersion) throw new Error('The template changed while saving.')
      if (!revision) throw new Error('A durable Extraction Template is required.')
      if (draft === null || !sameSchemaDefinition(draft, revision)) {
        draft = normalizeSchemaDefinition(revision)
        draftVersion += 1
      }
      extractableSchemaRevisionId = revision.schemaRevisionId
      replacementVersion += 1
      sourceCoverage = coverage
      return true
    }
    const revision = await persistence.initialize(definition, signal, coverage, pendingRecordScope ?? undefined)
    if (signal?.aborted || disposed || epoch !== replacementVersion) return false
    replacementVersion += 1
    draft = definition
    draftVersion += 1
    sourceCoverage = coverage
    extractableSchemaRevisionId = revision.schemaRevisionId
    return true
  }
  return {
    inputHandle() { return input ? activeHandle : null },
    beginInput(kind, value, commit) {
      writable()
      if (!draft) throw new Error('No template draft is open.')
      const id = Symbol('schema-input')
      input = { id, kind, value, error: null, stale: false }
      inputBaseVersion = draftVersion
      inputBaseScope = currentScope()
      inputEpoch = replacementVersion
      activeHandle = {
        update(value) {
          if (input?.id !== id) return
          input = { ...input, value, error: null }
          publish()
        },
        cancel() {
          if (input?.id !== id) return
          input = null; publish()
        },
        save() {
          if (input?.id !== id) return false
          try {
            if (disposed || inputIsStale() || !draft)
              throw new Error('The template changed. Copy your input, then Cancel and reopen the edit.')
            const next = commit(input.value)
            const fields = enumerateFieldPaths(next.schemaNodes)
            if (new Set(fields.map(f => f.id)).size !== fields.length) throw new Error('Field IDs must be unique.')
            const violation = newSchemaTreeViolation(draft.schemaNodes, next.schemaNodes)
            if (violation) throw new Error(violation.message)
            const previousProblems = definitionProblems(draft)
            for (const [key, message] of definitionProblems(next)) if (!previousProblems.has(key)) throw new Error(message)
            input = null
            applyDraft(next, '✎ Template updated')
            return true
          } catch (error) {
            if (input?.id === id) input = { ...input, error: error instanceof Error ? error.message : 'Invalid input.' }
            publish(); return false
          }
        },
      }
      publish()
      return activeHandle
    },
    markProposal(base) {
      const baseVersion = base?.draftVersion ?? draftVersion
      const baseRevision = base ? base.schemaRevisionId : extractableSchemaRevisionId
      const baseScope = currentScope()
      const baseEpoch = replacementVersion
      const token = Symbol('proposal')
      proposal = token; publish()
      function validity(): SchemaProposalValidity {
        if (proposal !== token || !draft || baseVersion !== draftVersion || baseRevision !== extractableSchemaRevisionId || baseEpoch !== replacementVersion || baseScope !== currentScope() || disposed)
          return { ok: false, reason: 'stale', message: 'Template changed during review. The proposal was discarded.' }
        const reason = input ? 'Save or Cancel the open edit first.'
          : preparing ? 'The template is being prepared; try again.'
          : historicalPreview || previewingRevisionId ? 'Close the historical preview first.'
          : creatingFromRevisionId ? 'A historical revision is being applied.' : null
        return reason ? { ok: false, reason: 'blocked', message: reason } : { ok: true }
      }
      return {
        validity,
        release() { if (proposal === token) { proposal = null; publish() } },
        apply(mutator, message) {
          const valid = validity()
          if (!valid.ok) return valid
          proposal = null
          const result = mutate(mutator, message)
          if (!result.ok) proposal = token
          publish()
          return result
        },
      }
    },
    async prepareUse() {
      const reason = blocked() ?? (generating ? 'Wait for template generation.' : null)
      if (reason) throw new Error(reason)
      const epoch = replacementVersion
      preparing = true; publish()
      try {
        const revision = await flushPersistence()
        const save = persistence.saveState()
        if (disposed || proposal || input || historicalPreview || previewingRevisionId || epoch !== replacementVersion || !revision || !draft || !sameSchemaDefinition(draft, revision) || save?.status !== 'saved' || save.recordScope !== revision.recordScope)
          throw new Error('The current template could not be prepared. Save or retry before running.')
        return Object.freeze({ extractionSchemaId: revision.extractionSchemaId, schemaRevisionId: revision.schemaRevisionId, recordScope: revision.recordScope })
      } finally { preparing = false; publish() }
    },
    snapshot() {
      return snapshot
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async generate(request, options = {}) {
      if (disposed) return
      writable()
      const base = draft ? structuredClone(draft) : null
      const baseScope = currentScope()
      const epoch = replacementVersion
      generationAbort?.abort()
      const abort = new AbortController()
      generationAbort = abort
      generationCancel = options.cancel ?? null
      const settle = () => {
        if (generationAbort === abort) generationCancel = null
      }
      generating = true
      generationError = null
      cancellationError = null
      historicalPreview = null
      publish()
      try {
        let declared: SourceCoverage | null = null
        const generatedSchema = await request(abort.signal, (coverage) => {
          declared = coverage
        })
        if (abort.signal.aborted || disposed) return
        if (input || proposal || baseScope !== currentScope() || epoch !== replacementVersion || (base === null ? draft !== null : !draft || !sameSchemaDefinition(base, draft))) throw new Error('The template changed during generation. Generate again from the current template.')
        const parsed = templateToSchemaDefinition(generatedSchema)
        const definition = normalizeSchemaDefinition(parsed)
        if (!(await adoptGenerated(definition, declared, abort.signal))) return
        generating = false
        publish()
      } catch (error) {
        if (abort.signal.aborted || disposed) return
        generating = false
        generationError =
          error instanceof Error ? error.message : 'Template generation failed.'
        publish()
      } finally {
        settle()
      }
    },
    operationScope() {
      return { projectContextId: persistence.projectContextId(), extractionSchemaId: persistence.extractionSchemaId() }
    },
    /** Saves a generation that finished while no tab waited for it (a reload or a restart), but only onto its base: the
     *  base is still the acknowledged revision of a clean draft, or no Extraction Schema exists yet. Anything else — and a
     *  conflict, meaning newer work landed first — drops it without an error (spec, *Generation*). */
    async restoreGeneration(template, baseSchemaRevisionId, coverage = null) {
      if (disposed || generating || blocked()) return false
      const save = persistence.saveState() ?? null
      const onBase = baseSchemaRevisionId === null
        ? (persistence.extractionSchemaId() ?? null) === null && draft === null
        : save?.status === 'saved' && save.acknowledged.schemaRevisionId === baseSchemaRevisionId
          && extractableSchemaRevisionId === baseSchemaRevisionId
      if (!onBase) return false
      let definition: SchemaDefinition
      try {
        definition = normalizeSchemaDefinition(templateToSchemaDefinition(template))
      } catch {
        return false
      }
      try {
        const saved = await adoptGenerated(definition, coverage)
        publish()
        return saved
      } catch (error) {
        if (disposed) return false
        // A conflict means newer work landed first: adopt it and drop the generation. Any other failure keeps the
        // visible draft (edits made meanwhile included) and the save engine's own error and retry.
        if (error instanceof SchemaRevisionConflictError) {
          const current = persistence.reloadCurrent() ?? null
          if (current) {
            draft = normalizeSchemaDefinition(current)
            draftVersion += 1
            replacementVersion += 1
            sourceCoverage = null
            extractableSchemaRevisionId = current.schemaRevisionId
          }
        }
        publish()
        return false
      }
    },
    cancelGeneration() {
      // A user's Stop: tell Studio, then stop waiting. dispose() only stops waiting — the workflow runs on and a
      // reloaded page finds it (spec, *A client abort only detaches*).
      const cancel = generationCancel
      generationCancel = null
      cancellationError = null
      // Stop waiting either way; a cancel Studio did not confirm is said, since the workflow may run on and the
      // reloaded panel will show it as an earlier request with its own Stop.
      void cancel?.().catch(() => {
        if (disposed) return
        cancellationError = 'The generation could not be stopped on the server; it may still be running and will show as an earlier request after a reload.'
        publish()
      })
      generationAbort?.abort()
      if (!generating) return
      generating = false
      publish()
    },

    async confirmDefinition(definition) {
      writable()
      await adoptGenerated(definition, null)
      publish()
    },
    commit(mutator, message) {
      if (blocked()) return { ok: false, reason: 'no-draft' }
      return mutate(mutator, message)
    },
    replaceDraft(definition, message) {
      writable()
      replacementVersion += 1
      // Recovery changes edit authority, while the edits still derive from the saved source declaration.
      applyDraft(normalizeSchemaDefinition(definition), message)
    },
    clearDraft(message) {
      if (blocked()) return { ok: false, reason: 'no-draft' }
      if (!draft) return { ok: false, reason: 'no-draft' }
      replacementVersion += 1
      applyDraft(
        { recordDescription: draft.recordDescription, schemaNodes: [] },
        message,
      )
      return { ok: true }
    },
    setRecordScope(recordScope) {
      writable()
      const save = persistence.saveState() ?? null
      if (!save) {
        // No revision yet: the first one declares the choice.
        if (recordScope === pendingRecordScope) return
        pendingRecordScope = recordScope
        publish()
        return
      }
      if (recordScope === save.recordScope) return
      // The acknowledged revision runs the other scope: it is no longer what a run would use until the save lands.
      extractableSchemaRevisionId = null
      historicalPreview = null
      persistence.setRecordScope(recordScope)
      publish()
      options.onCommitMessage?.(`✎ Strategy changed to ${recordScope === 'document' ? 'Article' : 'Catalog'}`)
    },

    async previewHistoricalRevision(schemaRevisionId) {
      if (input || preparing || proposal || creatingFromRevisionId || disposed) throw new Error(blocked() ?? 'Editor busy.')
      const request = ++previewRequest
      const epoch = replacementVersion
      previewingRevisionId = schemaRevisionId
      publish()
      try {
        const loaded = await persistence.getRevision(schemaRevisionId)
        if (request !== previewRequest || epoch !== replacementVersion || disposed) return loaded
        historicalPreview = loaded
        return historicalPreview
      } finally {
        if (request === previewRequest) previewingRevisionId = null
        if (!disposed) publish()
      }
    },
    closeHistoricalPreview() {
      previewRequest += 1
      previewingRevisionId = null
      if (historicalPreview === null) { publish(); return }
      historicalPreview = null
      publish()
    },
    async createCurrentRevisionFromHistory(schemaRevisionId) {
      if (input || preparing || proposal || disposed) throw new Error(blocked() ?? 'Editor busy.')
      if (creatingFromRevisionId !== null)
        throw new Error('A historical revision is already being applied.')
      const epoch = replacementVersion
      creatingFromRevisionId = schemaRevisionId
      publish()
      try {
        const loaded =
          historicalPreview?.schemaRevisionId === schemaRevisionId
            ? historicalPreview
            : await persistence.getRevision(schemaRevisionId)
        await flushPersistence()
        if (disposed || epoch !== replacementVersion) throw new Error('The template changed while loading history.')
        draft = normalizeSchemaDefinition(loaded)
        draftVersion += 1
        replacementVersion += 1
        historicalPreview = null
        extractableSchemaRevisionId = null
        // Restored content is not the current suggestion's: the new revision records no declaration.
        sourceCoverage = null
        persistence.edit(draft, null)
        publish()
        const savingEpoch = replacementVersion
        const created = await flushPersistence()
        if (disposed || savingEpoch !== replacementVersion) throw new Error('The template changed while saving history.')
        if (!created)
          throw new Error('A durable Extraction Template is required.')
        if (draft === null || !sameSchemaDefinition(draft, created)) {
          draft = normalizeSchemaDefinition(created)
          draftVersion += 1
        }
        replacementVersion += 1
        extractableSchemaRevisionId = created.schemaRevisionId
        historicalPreview = null
        options.onCommitMessage?.(
          `Created from Template Revision ${loaded.revisionNumber}`,
        )
        publish()
        return created
      } finally {
        creatingFromRevisionId = null
        if (!disposed) publish()
      }
    },

    async requestModelEdit() {
      const revision = await this.prepareUse()
      return persistence.modelContext(revision)
    },
    reloadCurrent() {
      const previousRevisionId = persistence.saveState()?.acknowledged.schemaRevisionId
      const revision = persistence.reloadCurrent()
      if (!revision) return null
      draft = normalizeSchemaDefinition(revision)
      // Reloading the same revision retains known provenance. A competing revision has its own lineage;
      // revision responses do not carry its declaration (a reopened Project Context supplies it).
      if (revision.schemaRevisionId !== previousRevisionId) sourceCoverage = null
      draftVersion += 1
      replacementVersion += 1
      generationError = null
      extractableSchemaRevisionId = revision.schemaRevisionId
      publish()
      return revision
    },
    flush() {
      return flushPersistence()
    },

    async reset() {
      writable()
      const epoch = replacementVersion
      preparing = true
      publish()
      try {
        await flushPersistence()
        if (disposed || epoch !== replacementVersion) throw new Error('The template changed while clearing.')
        generationAbort?.abort()
        generating = false
        generationError = null
        draft = null
        sourceCoverage = null
        draftVersion += 1
        replacementVersion += 1
        historicalPreview = null
        extractableSchemaRevisionId = null
      } finally {
        preparing = false
        publish()
      }
    },

    dispose() {
      disposed = true
      unsubscribeSave()
      historyAbort?.abort()
      generationAbort?.abort()
      persistence.dispose()
      listeners.clear()
    },
  }
}
