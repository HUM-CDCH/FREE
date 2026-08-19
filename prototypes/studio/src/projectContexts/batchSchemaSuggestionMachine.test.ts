import { createActor } from 'xstate'
import { describe, expect, it, vi } from 'vitest'
import type { SchemaDefinition } from '../../shared/schemaNode'
import {
  BatchSchemaSuggestionRequestError,
  type openBatchExtraction,
} from './batchExtractions'
import { batchSchemaSuggestionMachine } from './batchSchemaSuggestionMachine'

const projectContextId = '51000000-0000-4000-8000-000000000001'
const sourceDocumentId = '51000000-0000-4000-8001-000000000001'
const schemaRevisionId = '51000000-0000-4000-8004-000000000001'

const proposal = {
  status: 'ready' as const,
  selectionKey: 'a'.repeat(64),
  recordDescription: 'One record.',
  schemaNodes: [{ id: 'place', name: 'place', type: 'string' as const }],
  coverage: [{ nodeId: 'place', present: 1, total: 1 }],
}

const revision = {
  schemaRevisionId,
  extractionSchemaId: '51000000-0000-4000-8003-000000000001',
  revisionNumber: 1,
  origin: 'suggestion' as const,
  createdAt: '2026-08-15T10:00:00.000Z',
  recordDescription: 'One record.',
  schemaNodes: proposal.schemaNodes,
}

const opened = {
  batchExtraction: {
    batchExtractionId: '51000000-0000-4000-8006-000000000001',
    projectContextId,
    schemaRevisionId,
    extractionSchemaId: revision.extractionSchemaId,
    extractionSchemaName: 'Suggested Schema',
    schemaRevisionNumber: 1,
    strategy: 'ARTICLE' as const,
    createdAt: '2026-08-15T10:01:00.000Z',
    members: [],
  },
  disposition: 'created' as const,
} satisfies Awaited<ReturnType<typeof openBatchExtraction>>

function actorFixture(overrides: Record<string, unknown> = {}) {
  const merge = vi.fn(async () => proposal)
  const confirm = vi.fn(async () => revision)
  const open = vi.fn(async () => opened)
  const onOpened = vi.fn()
  const actor = createActor(batchSchemaSuggestionMachine, {
    input: {
      projectContextId,
      merge,
      confirm,
      open,
      onOpened,
      ...overrides,
    },
  }).start()
  actor.send({
    type: 'selection.changed',
    projectContextId,
    sourceDocumentIds: [sourceDocumentId],
  })
  return { actor, merge, confirm, open, onOpened }
}

describe('batchSchemaSuggestionMachine', () => {
  it('confirms and opens the exact proposal the researcher edited', async () => {
    const subject = actorFixture()
    subject.actor.send({ type: 'suggestion.requested' })
    await vi.waitFor(() =>
      expect(subject.actor.getSnapshot().matches('reviewing')).toBe(true),
    )
    const definition: SchemaDefinition = {
      recordDescription: 'Researcher-approved record.',
      schemaNodes: [{ id: 'place', name: 'approved_place', type: 'string' }],
    }
    subject.actor.send({ type: 'proposal.changed', definition })
    subject.actor.send({ type: 'run.requested', strategy: 'ARTICLE' })

    await vi.waitFor(() =>
      expect(subject.onOpened).toHaveBeenCalledWith(opened),
    )
    expect(subject.confirm).toHaveBeenCalledWith(
      projectContextId,
      [sourceDocumentId],
      proposal.selectionKey,
      definition,
      expect.any(AbortSignal),
    )
    expect(subject.actor.getSnapshot().matches('idle')).toBe(true)
    subject.actor.stop()
  })

  it('retries a failed open with the confirmed revision instead of reconfirming', async () => {
    const open = vi
      .fn()
      .mockRejectedValueOnce(new Error('Try again.'))
      .mockResolvedValueOnce(opened)
    const subject = actorFixture({ open })
    subject.actor.send({ type: 'suggestion.requested' })
    await vi.waitFor(() =>
      expect(subject.actor.getSnapshot().matches('reviewing')).toBe(true),
    )
    subject.actor.send({ type: 'run.requested', strategy: 'ARTICLE' })
    await vi.waitFor(() =>
      expect(subject.actor.getSnapshot().matches('openFailed')).toBe(true),
    )
    expect(subject.actor.getSnapshot().context.confirmedRevisionId).toBe(
      schemaRevisionId,
    )

    subject.actor.send({ type: 'run.requested', strategy: 'ARTICLE' })

    await vi.waitFor(() =>
      expect(subject.onOpened).toHaveBeenCalledWith(opened),
    )
    expect(subject.confirm).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledTimes(2)
    subject.actor.stop()
  })

  it('retains the proposal after a revision conflict and reconfirms explicitly', async () => {
    const confirm = vi
      .fn()
      .mockRejectedValueOnce(
        new BatchSchemaSuggestionRequestError(409, {
          code: 'revision_conflict',
          message: 'The Current Schema Revision changed.',
          details: { currentRevision: revision },
        }),
      )
      .mockResolvedValueOnce(revision)
    const subject = actorFixture({ confirm })
    subject.actor.send({ type: 'suggestion.requested' })
    await vi.waitFor(() =>
      expect(subject.actor.getSnapshot().matches('reviewing')).toBe(true),
    )
    subject.actor.send({ type: 'run.requested', strategy: 'ARTICLE' })
    await vi.waitFor(() =>
      expect(subject.actor.getSnapshot().matches('revisionConflict')).toBe(
        true,
      ),
    )
    expect(subject.actor.getSnapshot().context.proposal).toEqual(proposal)

    subject.actor.send({ type: 'run.requested', strategy: 'ARTICLE' })

    await vi.waitFor(() =>
      expect(subject.onOpened).toHaveBeenCalledWith(opened),
    )
    expect(confirm).toHaveBeenCalledTimes(2)
    subject.actor.stop()
  })

  it('discards a proposal invalidated by a changed selection and suggests again', async () => {
    const confirm = vi.fn().mockRejectedValue(
      new BatchSchemaSuggestionRequestError(409, {
        code: 'selection_changed',
        message: 'The Source Document selection changed. Suggest again.',
      }),
    )
    const subject = actorFixture({ confirm })
    subject.actor.send({ type: 'suggestion.requested' })
    await vi.waitFor(() =>
      expect(subject.actor.getSnapshot().matches('reviewing')).toBe(true),
    )
    subject.actor.send({ type: 'run.requested', strategy: 'ARTICLE' })

    await vi.waitFor(() =>
      expect(subject.actor.getSnapshot().matches('suggestionFailed')).toBe(
        true,
      ),
    )
    expect(subject.actor.getSnapshot().context.proposal).toBeNull()
    subject.actor.send({ type: 'run.requested', strategy: 'ARTICLE' })
    expect(confirm).toHaveBeenCalledOnce()

    subject.actor.send({ type: 'suggestion.requested' })
    await vi.waitFor(() =>
      expect(subject.actor.getSnapshot().matches('reviewing')).toBe(true),
    )
    expect(subject.merge).toHaveBeenCalledTimes(2)
    subject.actor.stop()
  })

  it('cancels a stale browser wait when the selection changes', async () => {
    const request = Promise.withResolvers<typeof proposal>()
    const subject = actorFixture({ merge: vi.fn(() => request.promise) })
    subject.actor.send({ type: 'suggestion.requested' })
    await vi.waitFor(() =>
      expect(subject.actor.getSnapshot().matches('suggesting')).toBe(true),
    )

    subject.actor.send({
      type: 'selection.changed',
      projectContextId,
      sourceDocumentIds: [],
    })
    request.resolve(proposal)

    await vi.waitFor(() =>
      expect(subject.actor.getSnapshot().matches('idle')).toBe(true),
    )
    expect(subject.actor.getSnapshot().context.proposal).toBeNull()
    subject.actor.stop()
  })
})
