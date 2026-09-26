import {
  duplicateFieldKeys,
  enumerateFieldPaths,
  mkId,
  templateToSchemaDefinition,
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
import { sameSchemaDefinition } from './schemaDefinitionEquality'
import type { SchemaModelContext } from './api'

// ────────────────────────────────────────────────────────────────────────────
// Persistence port
// ────────────────────────────────────────────────────────────────────────────

/**
 * Schema editing is the common capability. Durable revision, history, and
 * lifecycle operations are optional so local drafts expose only real storage
 * capabilities.
 */
export type SchemaEditorPersistence = {
  /** Hand each committed draft to this persistence's save engine. */
  edit(definition: SchemaDefinition): void
  /** Durable Extraction Schema identity; absent for local drafts. */
  extractionSchemaId?(): string | null
  /** The Project Context the durable schema lives in: the scope of the model operations a reloaded page looks for. */
  projectContextId?(): string
  initialize?(
    definition: SchemaDefinition,
    signal?: AbortSignal,
  ): Promise<SchemaRevision>
  flush?(): Promise<AcknowledgedSchemaRevision | null>
  saveState?(): SchemaSaveState | null
  reloadCurrent?(): AcknowledgedSchemaRevision | null
  /**
   * Map an acknowledged revision to a chat model context. Omit to disable
   * chat-driven schema edits for this persistence.
   */
  modelContext?(revision: AcknowledgedSchemaRevision): SchemaModelContext | null
  listRevisions?(
    limit: number,
    signal?: AbortSignal,
  ): Promise<SchemaRevisionSummary[]>
  getRevision?(
    schemaRevisionId: string,
    signal?: AbortSignal,
  ): Promise<SchemaRevision>
  onChange?(listener: () => void): () => void
  dispose?(): void
}

export type DurableSchemaPersistence = SchemaEditorPersistence &
  Required<
    Pick<
      SchemaEditorPersistence,
      | 'extractionSchemaId'
      | 'projectContextId'
      | 'initialize'
      | 'flush'
      | 'saveState'
      | 'reloadCurrent'
      | 'listRevisions'
      | 'getRevision'
      | 'onChange'
      | 'dispose'
    >
  >

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
  append(
    extractionSchemaId: string,
    expectedRevisionNumber: number,
    definition: SchemaDefinition,
  ): Promise<SchemaRevision>
  initialize(
    definition: SchemaDefinition,
    signal?: AbortSignal,
  ): Promise<SchemaRevision>
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
}): DurableSchemaPersistence {
  let extractionSchemaId = options.initial?.extractionSchemaId ?? null
  const listeners = new Set<() => void>()
  function notify() {
    for (const listener of listeners) listener()
  }
  // One append binding per coordinator; the Extraction Schema id arrives with
  // the first revision when the scope starts without one.
  const appendCurrent = (expected: number, definition: SchemaDefinition) => {
    if (extractionSchemaId === null)
      return Promise.reject(new Error('No durable schema is open.'))
    return options.append(extractionSchemaId, expected, definition)
  }
  let coordinator: SchemaSaveCoordinator | null = options.initial
    ? createSchemaSaveCoordinator(options.initial, appendCurrent, options.debounceMs, notify)
    : null
  function attach(revision: SchemaRevision) {
    extractionSchemaId = revision.extractionSchemaId
    coordinator = createSchemaSaveCoordinator(revision, appendCurrent, options.debounceMs, notify)
  }
  return {
    extractionSchemaId() {
      return extractionSchemaId
    },
    projectContextId() {
      return options.projectContextId
    },
    initialize(definition, signal) {
      if (coordinator) return Promise.reject(new Error('A durable schema is already open.'))
      return options.initialize(definition, signal).then((revision) => {
        attach(revision)
        notify()
        return revision
      })
    },
    edit(definition) {
      if (coordinator) coordinator.edit(definition)
    },
    flush() {
      return coordinator ? coordinator.flush() : Promise.resolve(null)
    },
    saveState() {
      return coordinator ? coordinator.state : null
    },
    reloadCurrent() {
      return coordinator?.reloadCurrent() ?? null
    },
    listRevisions(limit, signal) {
      if (extractionSchemaId === null) return Promise.resolve([])
      return options.listRevisions(extractionSchemaId, limit, signal)
    },
    getRevision(schemaRevisionId, signal) {
      if (extractionSchemaId === null)
        return Promise.reject(new Error('No durable schema is open.'))
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

/**
 * In-memory persistence for drafts outside the Extraction Schema revision
 * chain, such as a Batch Schema Suggestion. Every committed edit is forwarded
 * to the caller-owned draft machinery; nothing here claims durability.
 */
export function localSchemaPersistence(options: {
  onEdit(definition: SchemaDefinition): void
}): SchemaEditorPersistence {
  return { edit: options.onEdit }
}

// ────────────────────────────────────────────────────────────────────────────
// Controller
// ────────────────────────────────────────────────────────────────────────────

export type SchemaMutationResult =
  | { ok: true }
  | { ok: false; reason: 'no-draft' }
  | { ok: false; reason: 'duplicate-name'; duplicateName: string }

export type SchemaEditorSnapshot = {
  /** What the editor body renders: ungenerated / producing / failed / editing. */
  view: 'empty' | 'generating' | 'failed' | 'editing'
  /** Generation can run while the acknowledged current draft stays mounted. */
  generating: boolean
  generationError: string | null
  /** Editor payload; null until the first generation or adoption. */
  draft: SchemaDefinition | null
  /** Increments for every whole-draft mutation, including description edits. */
  draftVersion: number
  /** Increments when a wholesale external payload replaces the editor draft. */
  replacementVersion: number
  /** Durable save lifecycle; null when the persistence is not durable. */
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
}

export type SchemaEditorController = {
  snapshot(): SchemaEditorSnapshot
  subscribe(listener: () => void): () => void

  /** Runs a generation; `cancel` is what a user's Stop calls on the server, before the wait ends. */
  generate(
    request: (signal: AbortSignal) => Promise<unknown>,
    options?: { cancel?: () => Promise<void> },
  ): Promise<void>
  cancelGeneration(): void
  /** The durable scope a reloaded page lists model operations for; null for a local draft. */
  operationScope(): { projectContextId: string; extractionSchemaId: string | null } | null
  /** Saves a generation that finished while no tab waited for it, but only onto its base; true when it was saved. */
  restoreGeneration(template: unknown, baseSchemaRevisionId: string | null): Promise<boolean>

  commit(
    mutator: (nodes: SchemaNode[]) => SchemaNode[],
    message: string,
  ): SchemaMutationResult
  /** Replace the payload wholesale from the JSON editor. Trusted. */
  replaceDraft(definition: SchemaDefinition, message: string): void
  /** Adopt an externally refreshed draft without writing it back. */
  adoptDraft(definition: SchemaDefinition): void
  clearDraft(message: string): SchemaMutationResult
  setRecordDescription(recordDescription: string): void

  /** Create a new Current Schema Revision from a Historical Schema Revision. */
  previewHistoricalRevision(schemaRevisionId: string): Promise<SchemaRevision>
  closeHistoricalPreview(): void
  createCurrentRevisionFromHistory(
    schemaRevisionId: string,
  ): Promise<AcknowledgedSchemaRevision>

  requestModelEdit(): Promise<SchemaModelContext | null>
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
  } = {},
): SchemaEditorController {
  const historyLimit = options.historyLimit ?? 20
  let draft = options.initialDraft
    ? normalizeSchemaDefinition(options.initialDraft)
    : null
  let generating = false
  let generationError: string | null = null
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
  let disposed = false

  const listeners = new Set<() => void>()
  let snapshot: SchemaEditorSnapshot = buildSnapshot()

  function buildSnapshot(): SchemaEditorSnapshot {
    const save = persistence.saveState?.() ?? null
    return {
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
      draft,
      draftVersion,
      replacementVersion,
      save,
      history,
      extractionSchemaId: persistence.extractionSchemaId?.() ?? null,
      currentRevisionNumber:
        save?.acknowledged.revisionNumber ?? options.initialRevisionNumber,
      extractableSchemaRevisionId,
      creatingFromRevisionId,
      previewingRevisionId,
      historicalPreview,
    }
  }
  function publish() {
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
    options.onCommitMessage?.(message)
    persistence.edit(definition)
  }

  // Saves acknowledge → the extractable revision returns only when the visible
  // draft is exactly what persistence acknowledged; acknowledged revision
  // movement also refreshes history.
  let lastHistoryKey: string | null = null
  function reloadHistory() {
    historyAbort?.abort()
    if (!persistence.listRevisions) {
      history = []
      return
    }
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
    `${persistence.extractionSchemaId?.() ?? ''}:${persistence.saveState?.()?.acknowledged.revisionNumber ?? ''}`
  const unsubscribeSave =
    persistence.onChange?.(() => {
      const save = persistence.saveState?.() ?? null
      if (save?.status === 'saved' && draft !== null) {
        // The server owns canonicalization. Once the coordinator reports saved,
        // its acknowledgement is the authoritative visible and extractable tree.
        if (!sameSchemaDefinition(draft, save.acknowledged)) {
          draft = normalizeSchemaDefinition(save.acknowledged)
          draftVersion += 1
        }
        extractableSchemaRevisionId = save.acknowledged.schemaRevisionId
      } else if (save?.status === 'saved') {
        extractableSchemaRevisionId = null
      }
      publish()
      const key = historyKey()
      if (key !== lastHistoryKey) {
        lastHistoryKey = key
        reloadHistory()
      }
    }) ?? (() => {})
  lastHistoryKey = historyKey()
  reloadHistory()

  function flushPersistence() {
    return persistence.flush?.() ?? Promise.resolve(null)
  }

  /** Joins a generated candidate to the revision chain — onto the acknowledged head when a schema exists (the save
   *  coordinator's expected head), else as the first revision. generate() and restoreGeneration() share it. */
  async function adoptGenerated(definition: SchemaDefinition, signal?: AbortSignal): Promise<boolean> {
    if ((persistence.extractionSchemaId?.() ?? null) !== null) {
      // Keep the acknowledged current draft mounted and extractable while the generated candidate joins the revision
      // chain. The save acknowledgement is the only event allowed to replace it.
      persistence.edit(definition)
      const revision = await flushPersistence()
      if (!revision) throw new Error('A durable Extraction Schema is required.')
      if (draft === null || !sameSchemaDefinition(draft, revision)) {
        draft = normalizeSchemaDefinition(revision)
        draftVersion += 1
      }
      extractableSchemaRevisionId = revision.schemaRevisionId
      replacementVersion += 1
      return true
    }
    if (!persistence.initialize) throw new Error('Schema generation is unavailable for this draft.')
    const revision = await persistence.initialize(definition, signal)
    if (signal?.aborted || disposed) return false
    replacementVersion += 1
    draft = definition
    draftVersion += 1
    extractableSchemaRevisionId = revision.schemaRevisionId
    return true
  }
  return {
    snapshot() {
      return snapshot
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async generate(request, options = {}) {
      if (disposed) return
      generationAbort?.abort()
      const abort = new AbortController()
      generationAbort = abort
      generationCancel = options.cancel ?? null
      const settle = () => {
        if (generationAbort === abort) generationCancel = null
      }
      generating = true
      generationError = null
      historicalPreview = null
      publish()
      try {
        const generatedSchema = await request(abort.signal)
        if (abort.signal.aborted || disposed) return
        const parsed = templateToSchemaDefinition(generatedSchema)
        const definition = normalizeSchemaDefinition(parsed)
        if (!(await adoptGenerated(definition, abort.signal))) return
        generating = false
        publish()
      } catch (error) {
        if (abort.signal.aborted || disposed) return
        persistence.reloadCurrent?.()
        generating = false
        generationError =
          error instanceof Error ? error.message : 'Schema generation failed.'
        publish()
      } finally {
        settle()
      }
    },
    operationScope() {
      const projectContextId = persistence.projectContextId?.() ?? null
      return projectContextId === null ? null : { projectContextId, extractionSchemaId: persistence.extractionSchemaId?.() ?? null }
    },
    /** Saves a generation that finished while no tab waited for it (a reload or a restart), but only onto its base: the
     *  base is still the acknowledged revision of a clean draft, or no Extraction Schema exists yet. Anything else — and a
     *  conflict, meaning newer work landed first — drops it without an error (spec, *Generation*). */
    async restoreGeneration(template, baseSchemaRevisionId) {
      if (disposed || generating) return false
      const save = persistence.saveState?.() ?? null
      const onBase = baseSchemaRevisionId === null
        ? (persistence.extractionSchemaId?.() ?? null) === null && draft === null
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
        const saved = await adoptGenerated(definition)
        publish()
        return saved
      } catch {
        if (disposed) return false
        const current = persistence.reloadCurrent?.() ?? null
        if (current) {
          draft = normalizeSchemaDefinition(current)
          draftVersion += 1
          replacementVersion += 1
          extractableSchemaRevisionId = current.schemaRevisionId
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
      void cancel?.().catch(() => undefined)
      generationAbort?.abort()
      if (!generating) return
      generating = false
      publish()
    },

    commit(mutator, message) {
      if (!draft) return { ok: false, reason: 'no-draft' }
      const nextNodes = mutator(draft.schemaNodes)
      const fields = enumerateFieldPaths(nextNodes)
      const duplicates = duplicateFieldKeys(fields)
      if (duplicates.length > 0) {
        const duplicateName =
          fields.find(({ key }) => key === duplicates[0])!.node.name
        return { ok: false, reason: 'duplicate-name', duplicateName }
      }
      applyDraft(
        { recordDescription: draft.recordDescription, schemaNodes: nextNodes },
        message,
      )
      return { ok: true }
    },
    replaceDraft(definition, message) {
      applyDraft(normalizeSchemaDefinition(definition), message)
    },
    adoptDraft(definition) {
      extractableSchemaRevisionId = null
      replacementVersion += 1
      draft = normalizeSchemaDefinition(definition)
      draftVersion += 1
      historicalPreview = null
      generationError = null
      publish()
    },
    clearDraft(message) {
      if (!draft) return { ok: false, reason: 'no-draft' }
      applyDraft(
        { recordDescription: draft.recordDescription, schemaNodes: [] },
        message,
      )
      return { ok: true }
    },
    setRecordDescription(recordDescription) {
      if (!draft || recordDescription === draft.recordDescription) return
      applyDraft(
        { recordDescription, schemaNodes: draft.schemaNodes },
        '✎ Record description updated',
      )
    },

    async previewHistoricalRevision(schemaRevisionId) {
      if (!persistence.getRevision)
        throw new Error('Revision history is unavailable for this draft.')
      previewingRevisionId = schemaRevisionId
      publish()
      try {
        const loaded = await persistence.getRevision(schemaRevisionId)
        historicalPreview = {
          ...loaded,
          ...normalizeSchemaDefinition(loaded),
        }
        return historicalPreview
      } finally {
        previewingRevisionId = null
        if (!disposed) publish()
      }
    },
    closeHistoricalPreview() {
      if (historicalPreview === null) return
      historicalPreview = null
      publish()
    },
    async createCurrentRevisionFromHistory(schemaRevisionId) {
      if (!persistence.getRevision)
        throw new Error('Revision history is unavailable for this draft.')
      if (creatingFromRevisionId !== null)
        throw new Error('A historical revision is already being applied.')
      creatingFromRevisionId = schemaRevisionId
      publish()
      try {
        const loaded =
          historicalPreview?.schemaRevisionId === schemaRevisionId
            ? historicalPreview
            : await persistence.getRevision(schemaRevisionId)
        await flushPersistence()
        persistence.edit(normalizeSchemaDefinition(loaded))
        const created = await flushPersistence()
        if (!created)
          throw new Error('A durable Extraction Schema is required.')
        if (draft === null || !sameSchemaDefinition(draft, created)) {
          draft = normalizeSchemaDefinition(created)
          draftVersion += 1
        }
        replacementVersion += 1
        extractableSchemaRevisionId = created.schemaRevisionId
        historicalPreview = null
        options.onCommitMessage?.(
          `Created from Schema Revision ${loaded.revisionNumber}`,
        )
        publish()
        return created
      } catch (error) {
        const current = persistence.reloadCurrent?.() ?? null
        if (current) {
          draft = normalizeSchemaDefinition(current)
          extractableSchemaRevisionId = current.schemaRevisionId
          publish()
        }
        throw error
      } finally {
        creatingFromRevisionId = null
        if (!disposed) publish()
      }
    },

    async requestModelEdit() {
      const revision = await flushPersistence()
      if (!revision || !persistence.modelContext) return null
      return persistence.modelContext(revision)
    },
    reloadCurrent() {
      const revision = persistence.reloadCurrent?.() ?? null
      if (!revision) return null
      draft = normalizeSchemaDefinition(revision)
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
      await flushPersistence()
      generationAbort?.abort()
      generating = false
      generationError = null
      draft = null
      draftVersion += 1
      replacementVersion += 1
      historicalPreview = null
      extractableSchemaRevisionId = null
      publish()
    },

    dispose() {
      disposed = true
      unsubscribeSave()
      historyAbort?.abort()
      generationAbort?.abort()
      persistence.dispose?.()
      listeners.clear()
    },
  }
}
