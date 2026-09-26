import { sourceName, type SourceIngestionItem } from './sourceIngestionMachine'
import { createActor } from 'xstate'
import { describe, expect, it, vi } from 'vitest'
import type { SourceDocumentIngestionResponse } from '../shared/sourceDocumentIngestion.contract'
import { sourceIngestionMachine } from './sourceIngestionMachine'
import { ProjectContextRequestError, uncertainFailure } from './projectContexts/transport'

const projectContextId = '51000000-0000-4000-8000-000000000001'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function item(name: string, itemId: string, layout: 'pages' | 'spreads' = 'pages') {
  return {
    itemId,
    projectContextId,
    file: new File([name], name),
    layout,
  }
}

function reprocess(itemId: string, requestKey: string) {
  return {
    itemId,
    kind: 'reprocess' as const,
    projectContextId,
    sourceDocumentId: '51000000-0000-4000-8001-000000000001',
    expectedRepresentationId: '51000000-0000-4000-8002-000000000001',
    name: 'Beretning.pdf',
    layout: 'spreads' as const,
    requestKey,
  }
}

function result(sourceDocumentId: string, name: string) {
  return {
    sourceDocumentId,
    name,
    createdAt: '2026-08-12T10:00:00.000Z',
    sourceRepresentationId: '51000000-0000-4000-8002-000000000001',
    revisionNumber: 1,
    pageCount: 12,
  } satisfies SourceDocumentIngestionResponse
}

/** A failure the test marks as one whose outcome the server may still produce (a network error, 502, 503, 504). */
class Uncertain extends Error {}
const isUncertain = (error: unknown) => error instanceof Uncertain

describe('sourceIngestionMachine', () => {
  it('queues uploads by a client-only item id and sends no key', async () => {
    const sent: SourceIngestionItem[] = []
    const actor = createActor(sourceIngestionMachine, {
      input: {
        ingest: async (source) => {
          sent.push(source)
          return result('51000000-0000-4000-8001-000000000009', sourceName(source))
        },
        onIngested: vi.fn(),
        toFailureMessage: String,
        isUncertain,
      },
    }).start()

    // The same file twice is two items: nothing but the item id tells them apart.
    actor.send({ type: 'sources.added', items: [item('Scan.pdf', 'item-1'), item('Scan.pdf', 'item-2')] })
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent.map((source) => source.itemId)).toEqual(['item-1', 'item-2'])
    for (const source of sent) {
      expect(source).not.toHaveProperty('ingestionKey')
      expect(source).not.toHaveProperty('requestKey')
    }
  })

  it('retries an upload with the page layout it was added with', async () => {
    const layouts: string[] = []
    let fail = true
    const actor = createActor(sourceIngestionMachine, {
      input: {
        ingest: async (source) => {
          layouts.push(source.layout)
          if (fail) {
            fail = false
            throw new Error('parser unavailable')
          }
          return result('51000000-0000-4000-8001-000000000009',
            sourceName(source),
          )
        },
        onIngested: vi.fn(),
        toFailureMessage: (error) => String(error),
        isUncertain,
      },
    }).start()
    actor.send({ type: 'sources.added', items: [item('Scan.pdf', 'item-scan', 'spreads')] })
    await vi.waitFor(() => expect(actor.getSnapshot().context.items[0]?.status).toBe('failed'))
    actor.send({ type: 'source.retry', itemId: 'item-scan' })
    await vi.waitFor(() => expect(layouts).toEqual(['spreads', 'spreads']))
  })

  it('a reprocess retry re-sends its request key after an uncertain failure and mints a new one after a confirmed failure', async () => {
    const pending: Array<PromiseWithResolvers<SourceDocumentIngestionResponse>> = []
    const keys: string[] = []
    const actor = createActor(sourceIngestionMachine, {
      input: {
        ingest: (source) => {
          if (source.kind === 'reprocess') keys.push(source.requestKey)
          const request = Promise.withResolvers<SourceDocumentIngestionResponse>()
          pending.push(request)
          return request.promise
        },
        onIngested: vi.fn(),
        toFailureMessage: String,
        isUncertain,
      },
    }).start()
    const failed = async () =>
      vi.waitFor(() => expect(actor.getSnapshot().context.items[0]?.status).toBe('failed'))

    actor.send({ type: 'sources.added', items: [reprocess('item-r', 'key-1')] })
    await vi.waitFor(() => expect(keys).toEqual(['key-1']))
    // A 503 or a lost response: the server may have done the work, so the same key replays it.
    pending.shift()!.reject(new Uncertain('Parser temporarily unavailable.'))
    await failed()
    actor.send({ type: 'source.retry', itemId: 'item-r' })
    await vi.waitFor(() => expect(keys).toEqual(['key-1', 'key-1']))

    // A confirmed failure (a 422): repeating the key would replay it, so the retry is a new action.
    pending.shift()!.reject(new Error('The Source Document could not be parsed.'))
    await failed()
    actor.send({ type: 'source.retry', itemId: 'item-r' })
    await vi.waitFor(() => expect(keys).toHaveLength(3))
    expect(keys[2]).not.toBe('key-1')
    expect(keys[2]).toMatch(UUID)
    expect(actor.getSnapshot().context.items[0]).toMatchObject({ itemId: 'item-r', requestKey: keys[2] })
  })

  it('a terminal server timeout starts a new reprocess key while an unmarked timeout rejoins', async () => {
    const keys: string[] = []
    let terminal = false
    const actor = createActor(sourceIngestionMachine, { input: {
      ingest: async (source) => {
        if (source.kind === 'reprocess') keys.push(source.requestKey)
        throw new ProjectContextRequestError(504,
          { code: 'source_ingestion_timeout', message: 'The conversion timed out.' }, terminal)
      },
      onIngested: vi.fn(), toFailureMessage: String, isUncertain: uncertainFailure,
    } }).start()
    actor.send({ type: 'sources.added', items: [reprocess('item-terminal', 'first-key')] })
    await vi.waitFor(() => expect(actor.getSnapshot().context.items[0]?.status).toBe('failed'))
    terminal = true
    actor.send({ type: 'source.retry', itemId: 'item-terminal' })
    await vi.waitFor(() => expect(keys).toHaveLength(2))
    expect(keys).toEqual(['first-key', 'first-key'])
    await vi.waitFor(() => expect(actor.getSnapshot().context.items[0]?.status).toBe('failed'))
    actor.send({ type: 'source.retry', itemId: 'item-terminal' })
    await vi.waitFor(() => expect(keys).toHaveLength(3))
    expect(keys[2]).not.toBe('first-key')
    actor.stop()
  })

  it('processes sequentially, continues after failure, and retries the failed item', async () => {
    const pending: Array<PromiseWithResolvers<SourceDocumentIngestionResponse>> = []
    const writes: string[] = []
    const ingested = vi.fn()
    const actor = createActor(sourceIngestionMachine, {
      input: {
        ingest: (source) => {
          writes.push(source.itemId)
          const request = Promise.withResolvers<SourceDocumentIngestionResponse>()
          pending.push(request)
          return request.promise
        },
        onIngested: ingested,
        toFailureMessage: (error) => String(error),
        isUncertain,
      },
    }).start()
    const first = item('A.pdf', 'item-a')
    const second = item('B.pdf', 'item-b')
    const third = item('C.pdf', 'item-c')

    actor.send({ type: 'sources.added', items: [first, second, third] })
    await vi.waitFor(() => expect(writes).toEqual(['item-a']))
    pending.shift()!.resolve(result('51000000-0000-4000-8001-000000000001', 'A.pdf'))
    await vi.waitFor(() => expect(writes).toEqual(['item-a', 'item-b']))
    pending.shift()!.reject(new Error('bounded failure'))
    await vi.waitFor(() => expect(writes).toEqual(['item-a', 'item-b', 'item-c']))
    pending.shift()!.resolve(result('51000000-0000-4000-8001-000000000003', 'C.pdf'))

    await vi.waitFor(() => expect(actor.getSnapshot().matches('idle')).toBe(true))
    // An acknowledged Source Document leaves the queue in the same transition
    // that reports it, so only the failure is still held.
    expect(
      actor.getSnapshot().context.items.map((source) => [sourceName(source), source.status]),
    ).toEqual([['B.pdf', 'failed']])
    expect(ingested).toHaveBeenCalledTimes(2)

    actor.send({ type: 'source.retry', itemId: 'item-b' })
    await vi.waitFor(() =>
      expect(writes).toEqual(['item-a', 'item-b', 'item-c', 'item-b']),
    )
    pending.shift()!.resolve(result('51000000-0000-4000-8001-000000000002', 'B.pdf'))
    await vi.waitFor(() =>
      expect(actor.getSnapshot().context.items).toEqual([]),
    )
    expect(ingested).toHaveBeenCalledTimes(3)
  })

  it('drops a deleted project without cancelling or applying its late result', async () => {
    const request = Promise.withResolvers<SourceDocumentIngestionResponse>()
    const ingested = vi.fn()
    const actor = createActor(sourceIngestionMachine, {
      input: {
        ingest: () => request.promise,
        onIngested: ingested,
        toFailureMessage: String,
        isUncertain,
      },
    }).start()

    actor.send({ type: 'sources.added', items: [item('A.pdf', 'item-a')] })
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
          writes.push(source.itemId)
          const request = Promise.withResolvers<SourceDocumentIngestionResponse>()
          requests.push(request)
          return request.promise
        },
        onIngested: vi.fn(),
        toFailureMessage: String,
        isUncertain,
      },
    }).start()

    actor.send({ type: 'sources.added', items: [item('A.pdf', 'item-a')] })
    await vi.waitFor(() => expect(writes).toEqual(['item-a']))
    actor.send({ type: 'source.retry', itemId: 'item-a' })
    actor.send({ type: 'source.retry', itemId: 'missing' })
    expect(writes).toEqual(['item-a'])

    requests.shift()!.resolve(
      result('51000000-0000-4000-8001-000000000001', 'A.pdf'),
    )
    await vi.waitFor(() => expect(actor.getSnapshot().matches('idle')).toBe(true))
    // The acknowledged source is gone, so its retry has nothing to repeat and
    // its File is released.
    actor.send({ type: 'source.retry', itemId: 'item-a' })
    expect(writes).toEqual(['item-a'])
    expect(actor.getSnapshot().context.items).toEqual([])
  })

  it('holds client validation failures as item-scoped non-retryable errors', () => {
    const ingest = vi.fn()
    const actor = createActor(sourceIngestionMachine, {
      input: {
        ingest,
        onIngested: vi.fn(),
        toFailureMessage: String,
        isUncertain,
      },
    }).start()
    actor.send({
      type: 'sources.added',
      items: [
        {
          ...item('too-long.pdf', 'item-long'),
          validationFailure: 'Filename is too long.',
        },
      ],
    })

    expect(actor.getSnapshot().context.items).toMatchObject([
      {
        itemId: 'item-long',
        status: 'failed',
        failure: 'Filename is too long.',
      },
    ])
    actor.send({ type: 'source.retry', itemId: 'item-long' })
    expect(ingest).not.toHaveBeenCalled()
  })
})
