import { describe, expect, it, vi } from 'vitest'
import type { SchemaRevision } from '../shared/schemaRevision.contract'
import type { SchemaDefinition } from 'extraction/schema'
import { SchemaRevisionConflictError } from './schemaRevisions'
import { createSchemaSaveCoordinator } from './schemaSaveCoordinator'

const definition = (name: string): SchemaDefinition => ({
  recordDescription: `One ${name} record.`,
  schemaNodes: [{ id: `node-${name}`, name, type: 'string' }],
})
const revision = (number: number, name: string): SchemaRevision => ({
  schemaRevisionId: `51000000-0000-4000-8004-${String(number).padStart(12, '0')}`,
  extractionSchemaId: '51000000-0000-4000-8003-000000000001',
  revisionNumber: number,
  origin: 'researcher-edit',
  createdAt: `2026-08-01T12:0${number}:00.000Z`,
  ...definition(name),
})

describe('schema save coordinator', () => {
  it('debounces edits and acknowledges the returned durable revision', async () => {
    vi.useFakeTimers()
    const save = vi.fn(async (_expected: number, draft: SchemaDefinition) =>
      revision(2, draft.schemaNodes[0].name),
    )
    const coordinator = createSchemaSaveCoordinator(
      revision(1, 'site'),
      save,
      1500,
    )

    coordinator.edit(definition('year'))
    expect(coordinator.state.status).toBe('dirty')
    await vi.advanceTimersByTimeAsync(1499)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(save).toHaveBeenCalledWith(1, definition('year'))
    expect(coordinator.state).toMatchObject({
      status: 'saved',
      acknowledged: { revisionNumber: 2, ...definition('year') },
    })
    vi.useRealTimers()
  })

  it('allows one save in flight and retains only the latest queued draft', async () => {
    const first = Promise.withResolvers<SchemaRevision>()
    const save = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async () => revision(3, 'latest'))
    const coordinator = createSchemaSaveCoordinator(revision(1, 'site'), save, 0)

    coordinator.edit(definition('first'))
    await Promise.resolve()
    coordinator.edit(definition('intermediate'))
    coordinator.edit(definition('latest'))
    expect(save).toHaveBeenCalledTimes(1)
    first.resolve(revision(2, 'first'))
    await coordinator.flush()

    expect(save).toHaveBeenNthCalledWith(2, 2, definition('latest'))
    expect(coordinator.state.acknowledged.revisionNumber).toBe(3)
  })

  it('does not append when a restored definition already equals the acknowledged revision', async () => {
    const initial = revision(1, 'site')
    const save = vi.fn()
    const coordinator = createSchemaSaveCoordinator(initial, save, 60_000)

    coordinator.edit(definition('site'))
    await coordinator.flush()

    expect(save).not.toHaveBeenCalled()
    expect(coordinator.state).toMatchObject({
      status: 'saved',
      acknowledged: initial,
    })
  })

  it('flushes immediately and blocks on a conflict until current is reloaded', async () => {
    const winning = revision(2, 'rival')
    const save = vi.fn(async () => {
      throw new SchemaRevisionConflictError(winning)
    })
    const coordinator = createSchemaSaveCoordinator(
      revision(1, 'site'),
      save,
      60_000,
    )
    coordinator.edit(definition('mine'))

    await expect(coordinator.flush()).rejects.toBeInstanceOf(
      SchemaRevisionConflictError,
    )
    expect(coordinator.state).toMatchObject({
      status: 'conflict',
      currentRevision: winning,
      draft: definition('mine'),
    })
    expect(coordinator.reloadCurrent()).toEqual(winning)
    expect(coordinator.state).toMatchObject({
      status: 'saved',
      acknowledged: winning,
      draft: definition('rival'),
    })
  })
})
