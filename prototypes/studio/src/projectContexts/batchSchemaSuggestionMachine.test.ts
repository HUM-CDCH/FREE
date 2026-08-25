import { createActor } from 'xstate'
import { describe, expect, it, vi } from 'vitest'
import type { SchemaDefinition } from 'extraction/schema'
import type { BatchSchemaSuggestion } from '../../shared/batchSchemaSuggestion.contract'
import {
  batchSchemaSuggestionMachine,
  type BatchSchemaSuggestionOperations,
} from './batchSchemaSuggestionMachine'

const firstDefinition: SchemaDefinition = {
  recordDescription: 'One place.',
  schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
}
const secondDefinition: SchemaDefinition = {
  recordDescription: 'One place and year.',
  schemaNodes: [
    ...firstDefinition.schemaNodes,
    { id: 'year', name: 'year', type: 'number' },
  ],
}

function ready(
  definition: SchemaDefinition = firstDefinition,
  draftVersion = 0,
): BatchSchemaSuggestion {
  return {
    batchSchemaSuggestionId: '51000000-0000-4000-8008-000000000001',
    projectContextId: '51000000-0000-4000-8000-000000000001',
    selectionKey: 'a'.repeat(64),
    executionStatus: 'COMPLETED',
    phase: 'READY',
    proposal: definition,
    coverage: [],
    draft: definition,
    draftVersion,
    failure: null,
    confirmedSchemaRevisionId: null,
    batchExtractionId: null,
    startedAt: '2026-08-15T10:00:00.000Z',
    finishedAt: '2026-08-15T10:00:01.000Z',
    createdAt: '2026-08-15T10:00:00.000Z',
    sources: [],
  }
}

function operations(
  overrides: Partial<BatchSchemaSuggestionOperations> = {},
): BatchSchemaSuggestionOperations {
  return {
    create: async () => ready(),
    retry: async () => ready(),
    save: async (_suggestion, definition) => ready(definition, 1),
    run: async () => ({
      ...ready(firstDefinition, 1),
      confirmedSchemaRevisionId: '51000000-0000-4000-8005-000000000001',
      batchExtractionId: '51000000-0000-4000-8007-000000000001',
    }),
    isConflict: () => false,
    failureMessage: (error, fallback) =>
      error instanceof Error ? error.message : fallback,
    onSuggestion: () => {},
    onRun: () => {},
    ...overrides,
  }
}

function selected(actor: ReturnType<typeof createActor<typeof batchSchemaSuggestionMachine>>) {
  actor.send({
    type: 'selection.changed',
    sourceDocumentIds: ['51000000-0000-4000-8001-000000000001'],
    suggestion: null,
  })
}

describe('batchSchemaSuggestionMachine', () => {
  it('names create, poll, failure, retry, draft, and confirmed modes', async () => {
    const actor = createActor(batchSchemaSuggestionMachine, {
      input: operations(),
    }).start()
    selected(actor)
    actor.send({ type: 'suggestion.requested' })
    await vi.waitFor(() =>
      expect(actor.getSnapshot().matches({ drafting: 'clean' })).toBe(true),
    )

    actor.send({
      type: 'suggestion.updated',
      suggestion: {
        ...ready(),
        executionStatus: 'FAILED',
        phase: 'SOURCES',
        draft: null,
        proposal: null,
        failure: { code: 'model_failed', message: 'bounded failure' },
      },
    })
    expect(actor.getSnapshot().matches('failed')).toBe(true)
    actor.send({ type: 'suggestion.retry' })
    await vi.waitFor(() =>
      expect(actor.getSnapshot().matches({ drafting: 'clean' })).toBe(true),
    )
  })

  it('serializes a newer edit behind the in-flight save', async () => {
    const writes: SchemaDefinition[] = []
    const pending: Array<PromiseWithResolvers<BatchSchemaSuggestion>> = []
    const actor = createActor(batchSchemaSuggestionMachine, {
      input: operations({
        save: (_suggestion, definition) => {
          writes.push(definition)
          const request = Promise.withResolvers<BatchSchemaSuggestion>()
          pending.push(request)
          return request.promise
        },
      }),
    }).start()
    actor.send({
      type: 'selection.changed',
      sourceDocumentIds: ['51000000-0000-4000-8001-000000000001'],
      suggestion: ready(),
    })
    actor.send({ type: 'proposal.changed', definition: firstDefinition })
    actor.send({ type: 'draft.flush' })
    await vi.waitFor(() => expect(writes).toEqual([firstDefinition]))
    actor.send({ type: 'proposal.changed', definition: secondDefinition })
    pending.shift()!.resolve(ready(firstDefinition, 1))
    await vi.waitFor(() =>
      expect(writes).toEqual([firstDefinition, secondDefinition]),
    )
    pending.shift()!.resolve(ready(secondDefinition, 2))
    await vi.waitFor(() =>
      expect(actor.getSnapshot().matches({ drafting: 'clean' })).toBe(true),
    )
    expect(actor.getSnapshot().context.draft).toEqual(secondDefinition)
  })

  it('rejects Run after a failed save until a later edit is acknowledged', async () => {
    const save = vi
      .fn<BatchSchemaSuggestionOperations['save']>()
      .mockRejectedValueOnce(new Error('save failed'))
      .mockResolvedValueOnce(ready(secondDefinition, 1))
    const onRun = vi.fn()
    const actor = createActor(batchSchemaSuggestionMachine, {
      input: operations({ save, onRun }),
    }).start()
    actor.send({
      type: 'selection.changed',
      sourceDocumentIds: ['51000000-0000-4000-8001-000000000001'],
      suggestion: ready(),
    })
    actor.send({ type: 'proposal.changed', definition: secondDefinition })
    actor.send({ type: 'draft.flush' })
    await vi.waitFor(() =>
      expect(actor.getSnapshot().matches({ drafting: 'saveFailed' })).toBe(true),
    )
    expect(actor.getSnapshot().can({ type: 'run.requested' })).toBe(false)
    actor.send({ type: 'run.requested' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onRun).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledTimes(1)

    actor.send({ type: 'proposal.changed', definition: secondDefinition })
    actor.send({ type: 'draft.flush' })
    await vi.waitFor(() =>
      expect(actor.getSnapshot().matches({ drafting: 'clean' })).toBe(true),
    )
    expect(actor.getSnapshot().can({ type: 'run.requested' })).toBe(true)
    actor.send({ type: 'run.requested' })
    await vi.waitFor(() => expect(onRun).toHaveBeenCalledTimes(1))
    expect(save).toHaveBeenCalledTimes(2)
    expect(actor.getSnapshot().matches('confirmed')).toBe(true)
  })

  it('allows retrying Run after a transient run failure without editing the acknowledged draft', async () => {
    const run = vi
      .fn<BatchSchemaSuggestionOperations['run']>()
      .mockRejectedValueOnce(new Error('run failed'))
      .mockResolvedValueOnce({
        ...ready(firstDefinition, 1),
        confirmedSchemaRevisionId: '51000000-0000-4000-8005-000000000001',
        batchExtractionId: '51000000-0000-4000-8007-000000000001',
      })
    const onRun = vi.fn()
    const actor = createActor(batchSchemaSuggestionMachine, {
      input: operations({ run, onRun }),
    }).start()
    actor.send({
      type: 'selection.changed',
      sourceDocumentIds: ['51000000-0000-4000-8001-000000000001'],
      suggestion: ready(),
    })

    actor.send({ type: 'run.requested' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(actor.getSnapshot().matches({ drafting: 'clean' })).toBe(true),
    )
    expect(actor.getSnapshot().can({ type: 'run.requested' })).toBe(true)

    actor.send({ type: 'run.requested' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(onRun).toHaveBeenCalledTimes(1))
    expect(actor.getSnapshot().matches('confirmed')).toBe(true)
  })

  it('adopts the saved draft after a version conflict', async () => {
    const conflict = new Error('draft version conflict')
    const actor = createActor(batchSchemaSuggestionMachine, {
      input: operations({
        save: async () => {
          throw conflict
        },
        isConflict: (error) => error === conflict,
      }),
    }).start()
    actor.send({
      type: 'selection.changed',
      sourceDocumentIds: ['51000000-0000-4000-8001-000000000001'],
      suggestion: ready(),
    })
    actor.send({ type: 'proposal.changed', definition: secondDefinition })
    actor.send({ type: 'draft.flush' })
    await vi.waitFor(() =>
      expect(actor.getSnapshot().matches('conflict')).toBe(true),
    )

    actor.send({ type: 'suggestion.updated', suggestion: ready(firstDefinition, 2) })

    expect(actor.getSnapshot().matches({ drafting: 'clean' })).toBe(true)
    expect(actor.getSnapshot().context.draft).toEqual(firstDefinition)
    expect(actor.getSnapshot().context.suggestion?.draftVersion).toBe(2)
  })
})
