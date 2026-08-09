import { describe, expect, it, vi } from 'vitest'
import type { SchemaRevision } from '../shared/schemaRevision.contract'
import type { SchemaNode } from '../shared/schemaNode'
import { SchemaRevisionConflictError } from './schemaRevisions'
import { createSchemaSaveCoordinator } from './schemaSaveCoordinator'

const nodes = (name: string) => [{ id: `node-${name}`, name, type: 'string' as const }]
const revision = (number: number, name: string): SchemaRevision => ({
  schemaRevisionId: `51000000-0000-4000-8004-${String(number).padStart(12, '0')}`,
  extractionSchemaId: '51000000-0000-4000-8003-000000000001',
  revisionNumber: number,
  origin: 'researcher-edit',
  createdAt: `2026-08-01T12:0${number}:00.000Z`,
  schemaNodes: nodes(name),
})

describe('schema save coordinator', () => {
  it('debounces edits and acknowledges the returned durable revision', async () => {
    vi.useFakeTimers()
    const save = vi.fn(async (_expected: number, draft: SchemaNode[]) => revision(2, draft[0].name))
    const coordinator = createSchemaSaveCoordinator(revision(1, 'site'), save, 1500)

    coordinator.edit(nodes('year'))
    expect(coordinator.state.status).toBe('dirty')
    await vi.advanceTimersByTimeAsync(1499)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(save).toHaveBeenCalledWith(1, nodes('year'))
    expect(coordinator.state).toMatchObject({ status: 'saved', acknowledged: { revisionNumber: 2, schemaNodes: nodes('year') } })
    vi.useRealTimers()
  })

  it('allows one save in flight and retains only the latest queued draft', async () => {
    const first = Promise.withResolvers<SchemaRevision>()
    const save = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async () => revision(3, 'latest'))
    const coordinator = createSchemaSaveCoordinator(revision(1, 'site'), save, 0)

    coordinator.edit(nodes('first'))
    await Promise.resolve()
    coordinator.edit(nodes('intermediate'))
    coordinator.edit(nodes('latest'))
    expect(save).toHaveBeenCalledTimes(1)
    first.resolve(revision(2, 'first'))
    await coordinator.flush()

    expect(save).toHaveBeenNthCalledWith(2, 2, nodes('latest'))
    expect(coordinator.state.acknowledged.revisionNumber).toBe(3)
  })

  it('flushes immediately and blocks on a conflict until current is reloaded', async () => {
    const winning = revision(2, 'rival')
    const save = vi.fn(async () => { throw new SchemaRevisionConflictError(winning) })
    const coordinator = createSchemaSaveCoordinator(revision(1, 'site'), save, 60_000)
    coordinator.edit(nodes('mine'))

    await expect(coordinator.flush()).rejects.toBeInstanceOf(SchemaRevisionConflictError)
    expect(coordinator.state).toMatchObject({ status: 'conflict', currentRevision: winning, draft: nodes('mine') })
    expect(coordinator.reloadCurrent()).toEqual(winning)
    expect(coordinator.state).toMatchObject({ status: 'saved', acknowledged: winning, draft: winning.schemaNodes })
  })
})
