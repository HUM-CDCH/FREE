import { createActor } from 'xstate'
import { describe, expect, it, vi } from 'vitest'
import type { SourceDocumentIngestionResponse } from '../shared/sourceDocumentIngestion.contract'
import { sourceIngestionMachine } from './sourceIngestionMachine'

const projectContextId = '51000000-0000-4000-8000-000000000001'

function item(name: string, ingestionKey: string) {
  return {
    projectContextId,
    file: new File([name], name),
    ingestionKey,
    selectionKey: ingestionKey,
  }
}

function result(sourceDocumentId: string, name: string) {
  return {
    sourceDocumentId,
    name,
    createdAt: '2026-08-12T10:00:00.000Z',
    sourceRepresentationId: '51000000-0000-4000-8002-000000000001',
    revisionNumber: 1,
  } satisfies SourceDocumentIngestionResponse
}

describe('sourceIngestionMachine', () => {
  it('processes sequentially, continues after failure, and retries with the same key', async () => {
    const pending: Array<PromiseWithResolvers<SourceDocumentIngestionResponse>> = []
    const writes: string[] = []
    const ingested = vi.fn()
    const actor = createActor(sourceIngestionMachine, {
      input: {
        ingest: (source) => {
          writes.push(source.ingestionKey)
          const request = Promise.withResolvers<SourceDocumentIngestionResponse>()
          pending.push(request)
          return request.promise
        },
        onIngested: ingested,
        toFailureMessage: (error) => String(error),
      },
    }).start()
    const first = item('A.pdf', 'key-a')
    const second = item('B.pdf', 'key-b')
    const third = item('C.pdf', 'key-c')

    actor.send({ type: 'sources.added', items: [first, second, third] })
    await vi.waitFor(() => expect(writes).toEqual(['key-a']))
    pending.shift()!.resolve(result('51000000-0000-4000-8001-000000000001', 'A.pdf'))
    await vi.waitFor(() => expect(writes).toEqual(['key-a', 'key-b']))
    pending.shift()!.reject(new Error('bounded failure'))
    await vi.waitFor(() => expect(writes).toEqual(['key-a', 'key-b', 'key-c']))
    pending.shift()!.resolve(result('51000000-0000-4000-8001-000000000003', 'C.pdf'))

    await vi.waitFor(() => expect(actor.getSnapshot().matches('idle')).toBe(true))
    expect(actor.getSnapshot().context.items.map(({ status }) => status)).toEqual([
      'saved',
      'failed',
      'saved',
    ])
    expect(ingested).toHaveBeenCalledTimes(2)

    actor.send({ type: 'source.retry', ingestionKey: 'key-b' })
    await vi.waitFor(() =>
      expect(writes).toEqual(['key-a', 'key-b', 'key-c', 'key-b']),
    )
    pending.shift()!.resolve(result('51000000-0000-4000-8001-000000000002', 'B.pdf'))
    await vi.waitFor(() =>
      expect(actor.getSnapshot().context.items[1].status).toBe('saved'),
    )
  })

  it('drops a deleted project without cancelling or applying its late result', async () => {
    const request = Promise.withResolvers<SourceDocumentIngestionResponse>()
    const ingested = vi.fn()
    const actor = createActor(sourceIngestionMachine, {
      input: {
        ingest: () => request.promise,
        onIngested: ingested,
        toFailureMessage: String,
      },
    }).start()

    actor.send({ type: 'sources.added', items: [item('A.pdf', 'key-a')] })
    await vi.waitFor(() => expect(actor.getSnapshot().matches('ingesting')).toBe(true))
    actor.send({ type: 'project.deleted', projectContextId })
    expect(actor.getSnapshot().context.items).toEqual([])
    request.resolve(result('51000000-0000-4000-8001-000000000001', 'A.pdf'))

    await vi.waitFor(() => expect(actor.getSnapshot().matches('idle')).toBe(true))
    expect(ingested).not.toHaveBeenCalled()
  })

  it('ignores retry unless the source is failed', async () => {
    const requests: Array<PromiseWithResolvers<SourceDocumentIngestionResponse>> = []
    const writes: string[] = []
    const actor = createActor(sourceIngestionMachine, {
      input: {
        ingest: (source) => {
          writes.push(source.ingestionKey)
          const request = Promise.withResolvers<SourceDocumentIngestionResponse>()
          requests.push(request)
          return request.promise
        },
        onIngested: vi.fn(),
        toFailureMessage: String,
      },
    }).start()

    actor.send({ type: 'sources.added', items: [item('A.pdf', 'key-a')] })
    await vi.waitFor(() => expect(writes).toEqual(['key-a']))
    actor.send({ type: 'source.retry', ingestionKey: 'key-a' })
    actor.send({ type: 'source.retry', ingestionKey: 'missing' })
    expect(writes).toEqual(['key-a'])

    requests.shift()!.resolve(
      result('51000000-0000-4000-8001-000000000001', 'A.pdf'),
    )
    await vi.waitFor(() => expect(actor.getSnapshot().matches('idle')).toBe(true))
    actor.send({ type: 'source.retry', ingestionKey: 'key-a' })
    expect(writes).toEqual(['key-a'])
    expect(actor.getSnapshot().context.items[0].status).toBe('saved')
  })

  it('releases a saved File after its bounded confirmation', async () => {
    vi.useFakeTimers()
    const request = Promise.withResolvers<SourceDocumentIngestionResponse>()
    const actor = createActor(sourceIngestionMachine, {
      input: {
        ingest: () => request.promise,
        onIngested: vi.fn(),
        toFailureMessage: String,
      },
    }).start()

    try {
      actor.send({ type: 'sources.added', items: [item('A.pdf', 'key-a')] })
      await vi.advanceTimersByTimeAsync(0)
      request.resolve(
        result('51000000-0000-4000-8001-000000000001', 'A.pdf'),
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(actor.getSnapshot().context.items[0].status).toBe('saved')

      await vi.advanceTimersByTimeAsync(3_000)
      expect(actor.getSnapshot().context.items).toEqual([])
    } finally {
      actor.stop()
      vi.useRealTimers()
    }
  })
})
