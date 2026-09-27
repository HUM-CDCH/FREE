import { sourceName, type SourceIngestionItem } from './sourceIngestionMachine'
import { createActor } from 'xstate'
import { describe, expect, it, vi } from 'vitest'
import type { SourceDocumentIngestionResponse } from '../shared/sourceDocumentIngestion.contract'
import { sourceIngestionMachine } from './sourceIngestionMachine'
import { ProjectContextRequestError, uncertainFailure, type UploadAdmission } from './projectContexts/transport'

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

type Ingest = (source: SourceIngestionItem) => Promise<UploadAdmission>
type Reprocess = (source: SourceIngestionItem) => Promise<SourceDocumentIngestionResponse>
const never = () => new Promise<never>(() => {})

function started(options: { ingest?: Ingest; reprocess?: Reprocess; isUncertain?: (error: unknown) => boolean } = {}) {
  const onAdmitted = vi.fn()
  const onReplayed = vi.fn()
  const onIngested = vi.fn()
  const actor = createActor(sourceIngestionMachine, {
    input: {
      ingest: options.ingest ?? never,
      reprocess: options.reprocess ?? never,
      onAdmitted,
      onReplayed,
      onIngested,
      toFailureMessage: String,
      isUncertain: options.isUncertain ?? isUncertain,
    },
  }).start()
  const items = () => actor.getSnapshot().context.items
  return { actor, items, onAdmitted, onReplayed, onIngested }
}
const admitted = (workflowId: string): UploadAdmission => ({ kind: 'admitted', workflowId })
const statuses = (items: readonly SourceIngestionItem[]) => items.map((source) => [sourceName(source), source.status])

describe('sending uploads', () => {
  it('queues uploads by a client-only item id and sends no key', async () => {
    const sent: SourceIngestionItem[] = []
    const { actor } = started({ ingest: async (source) => { sent.push(source); return admitted(`wf-${source.itemId}`) } })

    // The same file twice is two items: nothing but the item id tells them apart.
    actor.send({ type: 'sources.added', items: [item('Scan.pdf', 'item-1'), item('Scan.pdf', 'item-2')] })
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent.map((source) => source.itemId)).toEqual(['item-1', 'item-2'])
    for (const source of sent) {
      expect(source).not.toHaveProperty('ingestionKey')
      expect(source).not.toHaveProperty('requestKey')
    }
  })

  it('sends one file at a time, and the next as soon as Studio admits the previous one', async () => {
    const pending: PromiseWithResolvers<UploadAdmission>[] = []
    const { actor, items, onAdmitted } = started({
      ingest: () => { const request = Promise.withResolvers<UploadAdmission>(); pending.push(request); return request.promise },
    })
    actor.send({ type: 'sources.added', items: [item('A.pdf', 'a'), item('B.pdf', 'b')] })
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(statuses(items())).toEqual([['A.pdf', 'sending'], ['B.pdf', 'waiting']])

    pending[0]!.resolve(admitted('wf-A'))
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(statuses(items())).toEqual([['A.pdf', 'admitted'], ['B.pdf', 'sending']])
    pending[1]!.resolve(admitted('wf-B'))
    await vi.waitFor(() => expect(statuses(items())).toEqual([['A.pdf', 'admitted'], ['B.pdf', 'admitted']]))
    expect(items().map((source) => source.kind !== 'reprocess' && source.workflowId)).toEqual(['wf-A', 'wf-B'])
    expect(onAdmitted).toHaveBeenCalledTimes(2)
    expect(onAdmitted.mock.calls[0]![1]).toBe('wf-A')
  })

  it('an admitted item leaves once the listing shows its workflow, and not before', async () => {
    const { actor, items } = started({ ingest: async () => admitted('wf-1') })
    actor.send({ type: 'sources.added', items: [item('A.pdf', 'a')] })
    await vi.waitFor(() => expect(items()[0]?.status).toBe('admitted'))
    actor.send({ type: 'ingestions.observed', projectContextId, workflowIds: ['wf-other'], absent: [] })
    actor.send({ type: 'ingestions.observed', projectContextId: 'another-project', workflowIds: ['wf-1'], absent: [] })
    expect(items()).toHaveLength(1)
    actor.send({ type: 'ingestions.observed', projectContextId, workflowIds: ['wf-1'], absent: [] })
    expect(items()).toHaveLength(0)
  })

  it('an admitted item the listing names absent leaves too (dismissed or collected elsewhere)', async () => {
    const { actor, items } = started({ ingest: async () => admitted('wf-1') })
    actor.send({ type: 'sources.added', items: [item('A.pdf', 'a')] })
    await vi.waitFor(() => expect(items()[0]?.status).toBe('admitted'))
    actor.send({ type: 'ingestions.observed', projectContextId, workflowIds: [], absent: ['wf-1'] })
    expect(items()).toHaveLength(0)
  })

  it('a second admission of a workflow another item already holds leaves at once', async () => {
    const { actor, items, onAdmitted } = started({ ingest: async () => admitted('wf-same') })
    actor.send({ type: 'sources.added', items: [item('A.pdf', 'a'), item('A copy.pdf', 'b')] })
    await vi.waitFor(() => expect(onAdmitted).toHaveBeenCalledTimes(2))
    expect(statuses(items())).toEqual([['A.pdf', 'admitted']])
  })

  it('a replayed upload acknowledges its document and leaves at once', async () => {
    const document = result('51000000-0000-4000-8001-000000000009', 'A.pdf')
    const { actor, items, onReplayed, onAdmitted } = started({ ingest: async () => ({ kind: 'replayed', document }) })
    actor.send({ type: 'sources.added', items: [item('A.pdf', 'a')] })
    await vi.waitFor(() => expect(onReplayed).toHaveBeenCalledOnce())
    expect(onReplayed.mock.calls[0]![1]).toEqual(document)
    expect(items()).toHaveLength(0)
    expect(onAdmitted).not.toHaveBeenCalled()
  })

  it('a send failure keeps the File for Retry, with the layout it was added with, and the queue continues', async () => {
    const sent: SourceIngestionItem[] = []
    let fail = true
    const { actor, items } = started({
      ingest: async (source) => {
        sent.push(source)
        if (fail) { fail = false; throw new Uncertain('network') }
        return admitted(`wf-${source.itemId}`)
      },
    })
    actor.send({ type: 'sources.added', items: [item('A.pdf', 'a', 'spreads'), item('B.pdf', 'b')] })
    await vi.waitFor(() => expect(statuses(items())).toEqual([['A.pdf', 'failed'], ['B.pdf', 'admitted']]))
    expect(items()[0]).toMatchObject({ uncertain: true, failure: 'Error: network' })
    actor.send({ type: 'source.retry', itemId: 'a' })
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    expect(sent[2]).toMatchObject({ itemId: 'a', layout: 'spreads' })
    expect(sent[2]!.kind !== 'reprocess' && sent[2]!.file.name).toBe('A.pdf')
    await vi.waitFor(() => expect(statuses(items())).toEqual([['A.pdf', 'admitted'], ['B.pdf', 'admitted']]))
    expect(items()[0]).not.toHaveProperty('failure', expect.anything())
  })

  it('drops a deleted project without cancelling or applying its late admission', async () => {
    const request = Promise.withResolvers<UploadAdmission>()
    const { actor, items, onAdmitted } = started({ ingest: () => request.promise })
    actor.send({ type: 'sources.added', items: [item('A.pdf', 'a')] })
    await vi.waitFor(() => expect(items()[0]?.status).toBe('sending'))
    actor.send({ type: 'project.deleted', projectContextId })
    expect(items()).toEqual([])
    request.resolve(admitted('wf-A'))
    await vi.waitFor(() => expect(actor.getSnapshot().matches({ uploads: 'idle' })).toBe(true))
    expect(onAdmitted).not.toHaveBeenCalled()
    expect(items()).toEqual([])
  })

  it('ignores retry unless the source is failed', async () => {
    const sent: string[] = []
    const { actor, items } = started({ ingest: async (source) => { sent.push(source.itemId); return admitted('wf-A') } })
    actor.send({ type: 'sources.added', items: [item('A.pdf', 'a')] })
    await vi.waitFor(() => expect(items()[0]?.status).toBe('admitted'))
    actor.send({ type: 'source.retry', itemId: 'a' })
    actor.send({ type: 'source.retry', itemId: 'missing' })
    expect(sent).toEqual(['a'])
    expect(items()[0]?.status).toBe('admitted')
  })

  it('holds client validation failures as item-scoped non-retryable errors', () => {
    const ingest = vi.fn()
    const { actor, items } = started({ ingest })
    actor.send({ type: 'sources.added', items: [{ ...item('too-long.pdf', 'item-long'), validationFailure: 'Filename is too long.' }] })
    expect(items()).toMatchObject([{ itemId: 'item-long', status: 'failed', failure: 'Filename is too long.' }])
    actor.send({ type: 'source.retry', itemId: 'item-long' })
    expect(ingest).not.toHaveBeenCalled()
  })
})

describe('reprocessing', () => {
  it('a reprocess waiting on its parse never holds an upload back', async () => {
    const ingest = vi.fn(async () => admitted('wf-A'))
    const { actor, items } = started({ ingest })
    actor.send({ type: 'sources.added', items: [reprocess('r', 'key-1'), item('A.pdf', 'a')] })
    await vi.waitFor(() => expect(statuses(items())).toEqual([['Beretning.pdf', 'parsing'], ['A.pdf', 'admitted']]))
    expect(ingest).toHaveBeenCalledOnce()
  })

  it('reports a reprocess result and leaves in the same transition', async () => {
    const revision = result('51000000-0000-4000-8001-000000000001', 'Beretning.pdf')
    const { actor, items, onIngested } = started({ reprocess: async () => revision })
    actor.send({ type: 'sources.added', items: [reprocess('r', 'key-1')] })
    await vi.waitFor(() => expect(onIngested).toHaveBeenCalledOnce())
    expect(onIngested.mock.calls[0]![0]).toMatchObject({ result: revision })
    expect(items()).toEqual([])
  })

  it('a reprocess retry re-sends its request key after an uncertain failure and mints a new one after a confirmed failure', async () => {
    const pending: Array<PromiseWithResolvers<SourceDocumentIngestionResponse>> = []
    const keys: string[] = []
    const { actor, items } = started({
      reprocess: (source) => {
        if (source.kind === 'reprocess') keys.push(source.requestKey)
        const request = Promise.withResolvers<SourceDocumentIngestionResponse>()
        pending.push(request)
        return request.promise
      },
    })
    const failed = async () => vi.waitFor(() => expect(items()[0]?.status).toBe('failed'))

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
    expect(items()[0]).toMatchObject({ itemId: 'item-r', requestKey: keys[2] })
  })

  it('a terminal server timeout starts a new reprocess key while an unmarked timeout rejoins', async () => {
    const keys: string[] = []
    let terminal = false
    const { actor, items } = started({
      isUncertain: uncertainFailure,
      reprocess: async (source) => {
        if (source.kind === 'reprocess') keys.push(source.requestKey)
        throw new ProjectContextRequestError(504, { code: 'source_ingestion_timeout', message: 'The conversion timed out.' }, terminal)
      },
    })
    actor.send({ type: 'sources.added', items: [reprocess('item-terminal', 'first-key')] })
    await vi.waitFor(() => expect(items()[0]?.status).toBe('failed'))
    terminal = true
    actor.send({ type: 'source.retry', itemId: 'item-terminal' })
    await vi.waitFor(() => expect(keys).toHaveLength(2))
    expect(keys).toEqual(['first-key', 'first-key'])
    await vi.waitFor(() => expect(items()[0]?.status).toBe('failed'))
    actor.send({ type: 'source.retry', itemId: 'item-terminal' })
    await vi.waitFor(() => expect(keys).toHaveLength(3))
    expect(keys[2]).not.toBe('first-key')
    actor.stop()
  })

  it('drops a deleted project without applying its late reprocess result', async () => {
    const request = Promise.withResolvers<SourceDocumentIngestionResponse>()
    const { actor, items, onIngested } = started({ reprocess: () => request.promise })
    actor.send({ type: 'sources.added', items: [reprocess('r', 'key-1')] })
    await vi.waitFor(() => expect(items()[0]?.status).toBe('parsing'))
    actor.send({ type: 'project.deleted', projectContextId })
    request.resolve(result('51000000-0000-4000-8001-000000000001', 'Beretning.pdf'))
    await vi.waitFor(() => expect(actor.getSnapshot().matches({ reprocesses: 'idle' })).toBe(true))
    expect(onIngested).not.toHaveBeenCalled()
  })
})
