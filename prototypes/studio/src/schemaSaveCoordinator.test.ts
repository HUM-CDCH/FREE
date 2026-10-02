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
  recordScope: 'document',
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

  it('does not append when a historical definition equals the acknowledgement', async () => {
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

  it('treats structurally identical definitions as equal regardless of key order', async () => {
    const initial = revision(1, 'site')
    const save = vi.fn(async () => revision(2, 'site'))
    const coordinator = createSchemaSaveCoordinator(initial, save, 60_000)
    const reordered: SchemaDefinition = {
      schemaNodes: [{ type: 'string', name: 'site', id: 'node-site' }],
      recordDescription: 'One site record.',
    }

    coordinator.edit(reordered)
    await coordinator.flush()

    expect(save).not.toHaveBeenCalled()
    expect(coordinator.state.status).toBe('saved')
  })

  it('cancels the pending debounce when an in-flight save chains the latest draft', async () => {
    vi.useFakeTimers()
    const first = Promise.withResolvers<SchemaRevision>()
    const second = Promise.withResolvers<SchemaRevision>()
    const save = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const onChange = vi.fn()
    const coordinator = createSchemaSaveCoordinator(
      revision(1, 'site'),
      save,
      100,
      onChange,
    )

    coordinator.edit(definition('first'))
    await vi.advanceTimersByTimeAsync(100)
    coordinator.edit(definition('latest'))

    first.resolve(revision(2, 'first'))
    await Promise.resolve()
    await Promise.resolve()
    expect(save).toHaveBeenCalledTimes(2)

    second.resolve(revision(3, 'latest'))
    await Promise.resolve()
    await Promise.resolve()
    expect(coordinator.state.status).toBe('saved')
    const notificationsAfterSave = onChange.mock.calls.length

    await vi.advanceTimersByTimeAsync(100)

    expect(onChange).toHaveBeenCalledTimes(notificationsAfterSave)
    vi.useRealTimers()
  })

  it('flushes immediately and reloads the winning revision after a conflict', async () => {
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

  it('saves a scope change as an append that names it, and edits as appends that inherit it', async () => {
    const save = vi.fn(async (expected: number, draft: SchemaDefinition, recordScope?: 'document' | 'records') => ({
      ...revision(expected + 1, draft.schemaNodes[0].name),
      recordScope: recordScope ?? 'document',
    }))
    const coordinator = createSchemaSaveCoordinator(revision(1, 'site'), save, 60_000)

    coordinator.setRecordScope('document')
    await coordinator.flush()
    expect(save).not.toHaveBeenCalled()

    coordinator.setRecordScope('records')
    // A scope change saves at once: it does not wait out the 60 s debounce.
    expect(coordinator.state).toMatchObject({ status: 'saving', recordScope: 'records' })
    await expect(coordinator.flush()).resolves.toMatchObject({ revisionNumber: 2, recordScope: 'records' })
    expect(save).toHaveBeenLastCalledWith(1, definition('site'), 'records')

    // The acknowledged revision now holds the scope: the next edit names none and the server keeps it.
    vi.mocked(save).mockImplementationOnce(async (expected, draft) => ({
      ...revision(expected + 1, draft.schemaNodes[0].name),
      recordScope: 'records',
    }))
    coordinator.edit(definition('year'))
    await coordinator.flush()
    expect(save).toHaveBeenLastCalledWith(2, definition('year'))
    expect(coordinator.state).toMatchObject({ status: 'saved', recordScope: 'records' })
  })

  it('keeps a scope chosen during a conflict until the winning revision is reloaded', async () => {
    const winning = { ...revision(2, 'rival'), recordScope: null }
    const save = vi.fn(async () => {
      throw new SchemaRevisionConflictError(winning)
    })
    const coordinator = createSchemaSaveCoordinator(revision(1, 'site'), save, 60_000)
    coordinator.setRecordScope('records')
    await expect(coordinator.flush()).rejects.toBeInstanceOf(SchemaRevisionConflictError)
    coordinator.setRecordScope('document')
    expect(coordinator.state).toMatchObject({ status: 'conflict', recordScope: 'document' })
    coordinator.reloadCurrent()
    expect(coordinator.state).toMatchObject({ status: 'saved', recordScope: null })
  })

  it('saves a scope change at once, carrying the pending edit in the same revision', async () => {
    vi.useFakeTimers()
    const save = vi.fn(async (expected: number, draft: SchemaDefinition, recordScope?: 'document' | 'records') => ({
      ...revision(expected + 1, draft.schemaNodes[0].name),
      recordScope: recordScope ?? 'document',
    }))
    const coordinator = createSchemaSaveCoordinator(revision(1, 'site'), save, 1500)

    coordinator.edit(definition('year'))
    await vi.advanceTimersByTimeAsync(500)
    coordinator.setRecordScope('records')
    await vi.advanceTimersByTimeAsync(0)

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(1, definition('year'), 'records')
    expect(coordinator.state).toMatchObject({
      status: 'saved',
      recordScope: 'records',
      acknowledged: { revisionNumber: 2, recordScope: 'records', ...definition('year') },
    })
    // The edit's debounce was taken over by the scope save: nothing appends again.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(save).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('serializes rapid scope changes: one save in flight, the last choice saved last, no stale overwrite', async () => {
    const held = Promise.withResolvers<SchemaRevision>()
    const save = vi
      .fn()
      .mockImplementationOnce(() => held.promise)
      .mockImplementation(async (expected: number, draft: SchemaDefinition, recordScope?: 'document' | 'records') => ({
        ...revision(expected + 1, draft.schemaNodes[0].name),
        recordScope: recordScope ?? 'records',
      }))
    const coordinator = createSchemaSaveCoordinator(revision(1, 'site'), save, 1500)

    coordinator.setRecordScope('records')
    coordinator.setRecordScope('document')
    coordinator.edit(definition('year'))
    coordinator.setRecordScope('records')
    coordinator.setRecordScope('document')
    coordinator.setRecordScope('records')
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenNthCalledWith(1, 1, definition('site'), 'records')

    const flushed = coordinator.flush()
    held.resolve({ ...revision(2, 'site'), recordScope: 'records' })
    await expect(flushed).resolves.toMatchObject({ revisionNumber: 3, recordScope: 'records', ...definition('year') })

    // The re-save carries the latest draft on the acknowledged head; its scope already matches, so it names none.
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenNthCalledWith(2, 2, definition('year'))
    expect(coordinator.state).toMatchObject({ status: 'saved', recordScope: 'records', draft: definition('year') })
  })

  it('re-saves a scope chosen while its previous choice is in flight', async () => {
    const held = Promise.withResolvers<SchemaRevision>()
    const save = vi
      .fn()
      .mockImplementationOnce(() => held.promise)
      .mockImplementation(async (expected: number, draft: SchemaDefinition, recordScope?: 'document' | 'records') => ({
        ...revision(expected + 1, draft.schemaNodes[0].name),
        recordScope: recordScope ?? 'records',
      }))
    const coordinator = createSchemaSaveCoordinator(revision(1, 'site'), save, 1500)

    coordinator.setRecordScope('records')
    coordinator.setRecordScope('document')
    const flushed = coordinator.flush()
    held.resolve({ ...revision(2, 'site'), recordScope: 'records' })

    await expect(flushed).resolves.toMatchObject({ revisionNumber: 3, recordScope: 'document' })
    expect(save).toHaveBeenNthCalledWith(2, 2, definition('site'), 'document')
    expect(coordinator.state).toMatchObject({ status: 'saved', recordScope: 'document' })
  })

  it('keeps a failed save visible until flush retries it', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network down.'))
      .mockImplementation(async (expected: number, draft: SchemaDefinition, recordScope?: 'document' | 'records') => ({
        ...revision(expected + 1, draft.schemaNodes[0].name),
        recordScope: recordScope ?? 'document',
      }))
    const coordinator = createSchemaSaveCoordinator(revision(1, 'site'), save, 1500)

    coordinator.edit(definition('year'))
    coordinator.setRecordScope('records')
    await expect(coordinator.flush()).rejects.toThrow('Network down.')
    expect(coordinator.state).toMatchObject({ status: 'error', recordScope: 'records', draft: definition('year') })
    expect(coordinator.state.error?.message).toBe('Network down.')

    await expect(coordinator.flush()).resolves.toMatchObject({ revisionNumber: 2, recordScope: 'records' })
    expect(save).toHaveBeenLastCalledWith(1, definition('year'), 'records')
    expect(coordinator.state.status).toBe('saved')
    expect(coordinator.state.error).toBeUndefined()
  })

  it('starts the debounced save on dispose instead of dropping it', async () => {
    vi.useFakeTimers()
    const save = vi.fn(async (expected: number, draft: SchemaDefinition) => revision(expected + 1, draft.schemaNodes[0].name))
    const coordinator = createSchemaSaveCoordinator(revision(1, 'site'), save, 1500)

    coordinator.dispose()
    expect(save).not.toHaveBeenCalled()

    coordinator.edit(definition('year'))
    coordinator.dispose()
    expect(save).toHaveBeenCalledExactlyOnceWith(1, definition('year'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(save).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('retries a failed save on dispose instead of dropping it', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network down.'))
      .mockImplementation(async (expected: number, draft: SchemaDefinition, recordScope?: 'document' | 'records') => ({
        ...revision(expected + 1, draft.schemaNodes[0].name),
        recordScope: recordScope ?? 'document',
      }))
    const coordinator = createSchemaSaveCoordinator(revision(1, 'site'), save, 1500)
    coordinator.setRecordScope('records')
    await expect(coordinator.flush()).rejects.toThrow('Network down.')

    coordinator.dispose()

    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith(1, definition('site'), 'records')
  })
})
