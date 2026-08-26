import type { SchemaDefinition } from 'extraction/schema'
import type { SchemaRevision } from '../shared/schemaRevision.contract'
import { sameSchemaDefinition } from './schemaDefinitionEquality'
import { SchemaRevisionConflictError } from './schemaRevisions'

export type AcknowledgedSchemaRevision = Pick<
  SchemaRevision,
  | 'schemaRevisionId'
  | 'extractionSchemaId'
  | 'revisionNumber'
  | 'recordDescription'
  | 'schemaNodes'
>

export type SchemaSaveState = {
  status: 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'
  acknowledged: AcknowledgedSchemaRevision
  draft: SchemaDefinition
  currentRevision?: SchemaRevision
  error?: Error
}

type Save = (
  expectedRevisionNumber: number,
  definition: SchemaDefinition,
) => Promise<SchemaRevision>

const definitionOf = (
  revision: AcknowledgedSchemaRevision,
): SchemaDefinition => ({
  recordDescription: revision.recordDescription,
  schemaNodes: revision.schemaNodes,
})

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
    if (
      inFlight ||
      sameSchemaDefinition(state.draft, definitionOf(state.acknowledged))
    ) {
      if (!inFlight) {
        publish({ ...state, status: 'saved' })
        settle()
      }
      return
    }
    inFlight = true
    const submitted = state.draft
    const expected = state.acknowledged.revisionNumber
    publish({ ...state, status: 'saving' })
    try {
      const acknowledged = await save(expected, submitted)
      inFlight = false
      if (sameSchemaDefinition(state.draft, submitted)) {
        publish({
          status: 'saved',
          acknowledged,
          draft: definitionOf(acknowledged),
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
    flush(): Promise<AcknowledgedSchemaRevision> {
      if (state.status === 'conflict')
        return Promise.reject(
          new SchemaRevisionConflictError(state.currentRevision!),
        )
      if (state.status === 'error') return Promise.reject(state.error)
      if (
        !inFlight &&
        sameSchemaDefinition(state.draft, definitionOf(state.acknowledged))
      ) {
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
