import type { RecordScope, SchemaDefinition } from 'extraction/schema'
import type { SchemaRevision } from '../shared/schemaRevision.contract'
import { sameSchemaDefinition } from './schemaDefinitionEquality'
import { SchemaRevisionConflictError } from './schemaRevisions'

export type AcknowledgedSchemaRevision = Pick<
  SchemaRevision,
  | 'schemaRevisionId'
  | 'extractionSchemaId'
  | 'revisionNumber'
  | 'recordDescription'
  | 'recordScope'
  | 'schemaNodes'
>

export type SchemaSaveState = {
  status: 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'
  acknowledged: AcknowledgedSchemaRevision
  draft: SchemaDefinition
  /**
   * The record scope the draft is saved with: the acknowledged revision's until the researcher chooses another. It is
   * kept beside the definition, never in it, so an edit's append omits it and inherits its head's.
   */
  recordScope: RecordScope | null
  currentRevision?: SchemaRevision
  error?: Error
}

/** `recordScope` is given only for a scope change; omitted, the new revision inherits its head's. */
type Save = (
  expectedRevisionNumber: number,
  definition: SchemaDefinition,
  recordScope?: RecordScope,
) => Promise<SchemaRevision>

const definitionOf = (
  revision: AcknowledgedSchemaRevision,
): SchemaDefinition => ({
  recordDescription: revision.recordDescription,
  schemaNodes: revision.schemaNodes,
})

/** Whether the draft and its scope are exactly what `acknowledged` saved. */
const savedAs = (
  acknowledged: AcknowledgedSchemaRevision,
  draft: SchemaDefinition,
  recordScope: RecordScope | null,
) =>
  recordScope === acknowledged.recordScope &&
  sameSchemaDefinition(draft, definitionOf(acknowledged))

export function createSchemaSaveCoordinator(
  initial: AcknowledgedSchemaRevision,
  save: Save,
  debounceMs = 1500,
  onChange: (state: SchemaSaveState) => void = () => undefined,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let state: SchemaSaveState = {
    status: 'saved',
    acknowledged: initial,
    draft: definitionOf(initial),
    recordScope: initial.recordScope,
  }
  let waiters: Array<{
    resolve: (revision: AcknowledgedSchemaRevision) => void
    reject: (error: Error) => void
  }> = []

  const publish = (next: SchemaSaveState) => {
    state = next
    onChange(state)
  }
  const settle = (error?: Error) => {
    const pending = waiters
    waiters = []
    for (const waiter of pending)
      if (error) waiter.reject(error)
      else waiter.resolve(state.acknowledged)
  }
  const clearScheduled = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const start = async (): Promise<void> => {
    clearScheduled()
    if (inFlight || savedAs(state.acknowledged, state.draft, state.recordScope)) {
      if (!inFlight) {
        publish({ ...state, status: 'saved' })
        settle()
      }
      return
    }
    inFlight = true
    const submitted = state.draft
    const submittedScope = state.recordScope
    const expected = state.acknowledged.revisionNumber
    // Only a scope change names one; every other save inherits its head's.
    const scopeChange =
      submittedScope !== null && submittedScope !== state.acknowledged.recordScope
        ? submittedScope
        : undefined
    publish({ ...state, status: 'saving' })
    try {
      const acknowledged = scopeChange
        ? await save(expected, submitted, scopeChange)
        : await save(expected, submitted)
      inFlight = false
      if (sameSchemaDefinition(state.draft, submitted) && state.recordScope === submittedScope) {
        publish({
          status: 'saved',
          acknowledged,
          draft: definitionOf(acknowledged),
          recordScope: acknowledged.recordScope,
        })
        settle()
      } else {
        publish({ ...state, status: 'dirty', acknowledged })
        void start()
      }
    } catch (error) {
      inFlight = false
      if (error instanceof SchemaRevisionConflictError) {
        publish({
          ...state,
          status: 'conflict',
          currentRevision: error.currentRevision,
        })
        settle(error)
      } else {
        const failure =
          error instanceof Error ? error : new Error('Schema save failed.')
        publish({ ...state, status: 'error', error: failure })
        settle(failure)
      }
    }
  }
  const schedule = () => {
    clearScheduled()
    if (debounceMs === 0) void start()
    else timer = setTimeout(() => void start(), debounceMs)
  }

  return {
    get state() {
      return state
    },
    edit(definition: SchemaDefinition) {
      if (state.status === 'conflict')
        publish({ ...state, draft: definition })
      else {
        publish({
          ...state,
          status: inFlight ? 'saving' : 'dirty',
          draft: definition,
        })
        schedule()
      }
    },
    /** A scope change is a schema change: saved through the same debounce, conflict check and flush as an edit. */
    setRecordScope(recordScope: RecordScope) {
      if (state.status === 'conflict') publish({ ...state, recordScope })
      else {
        publish({
          ...state,
          status: inFlight ? 'saving' : 'dirty',
          recordScope,
        })
        schedule()
      }
    },
    flush(): Promise<AcknowledgedSchemaRevision> {
      if (state.status === 'conflict')
        return Promise.reject(
          new SchemaRevisionConflictError(state.currentRevision!),
        )
      if (state.status === 'error') return Promise.reject(state.error)
      if (!inFlight && savedAs(state.acknowledged, state.draft, state.recordScope)) {
        publish({ ...state, status: 'saved' })
        return Promise.resolve(state.acknowledged)
      }
      clearScheduled()
      const promise = new Promise<AcknowledgedSchemaRevision>(
        (resolve, reject) => {
          waiters.push({ resolve, reject })
        },
      )
      void start()
      return promise
    },
    reloadCurrent(): AcknowledgedSchemaRevision {
      const acknowledged =
        state.status === 'conflict' && state.currentRevision
          ? state.currentRevision
          : state.acknowledged
      publish({
        status: 'saved',
        acknowledged,
        draft: definitionOf(acknowledged),
        recordScope: acknowledged.recordScope,
      })
      return acknowledged
    },
    dispose() {
      clearScheduled()
    },
  }
}

export type SchemaSaveCoordinator = ReturnType<
  typeof createSchemaSaveCoordinator
>
