// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import { ADMISSIONS_DISABLED, EXTRACTION_UNAVAILABLE, MONITOR_DISCONNECTED, useExtraction } from './useExtraction'

const target = { sourceRepresentationId: '51000000-0000-4000-8002-000000000001', schemaRevisionId: '51000000-0000-4000-8005-000000000001' }
const method = { models: null, settings: { article: null } }

function attempt(extractionId: string, executionStatus: ExtractionAttempt['executionStatus'] = 'QUEUED'): ExtractionAttempt {
  return {
    extractionId, sourceDocumentId: '51000000-0000-4000-8001-000000000001',
    sourceRepresentationRevisionId: target.sourceRepresentationId, schemaRevisionId: target.schemaRevisionId,
    strategy: 'ARTICLE', catalogRecipe: null, requestedModels: null, requestedSettings: null,
    executionStatus, finalizedReview: null, batchExtractionId: null, createdAt: '2026-10-05T00:00:00.000Z',
  }
}

/** The server: `post` answers an admission, `read` the status read of an admitted identity. Every request is kept. */
function server({ post, read }: {
  post: (body: { id: string }) => Response
  read?: (id: string) => Response
}) {
  const posts: Array<{ id: string }> = []
  const reads: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/extractions' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { id: string }
      posts.push(body)
      return post(body)
    }
    const id = /^\/api\/extractions\/([^/]+)$/.exec(url)?.[1]
    if (id) {
      reads.push(id)
      return read ? read(id) : Response.json({ extraction: attempt(id, 'RUNNING') })
    }
    throw new Error(`Unexpected request ${url}`)
  }))
  return { posts, reads }
}

function render(options: Partial<Parameters<typeof useExtraction>[0]> = {}) {
  const callbacks = { onTerminal: vi.fn(), onError: vi.fn(), onSuperseded: vi.fn(), onMethodChanged: vi.fn() }
  const hook = renderHook((props: Partial<Parameters<typeof useExtraction>[0]>) => useExtraction({
    schemaReady: true, indexing: false, reviewTarget: target, documentKey: 'document', ...callbacks, ...options, ...props,
  }), { initialProps: {} })
  return { ...hook, ...callbacks }
}

beforeEach(() => vi.useRealTimers())
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('durable Extraction admission', () => {
  it('admits under a fresh identity and hands the queued Extraction to its controls', async () => {
    const { posts } = server({ post: (body) => Response.json(attempt(body.id), { status: 201 }) })
    const { result } = render()
    expect(result.current.canRun).toBe(true)
    let acknowledged: ExtractionAttempt | null = null
    await act(async () => { acknowledged = await result.current.runExtraction(method, target) })
    expect(posts).toEqual([expect.objectContaining({ id: expect.any(String), schemaRevisionId: target.schemaRevisionId, method })])
    expect(acknowledged).toEqual(attempt(posts[0]!.id))
    expect(result.current.attempt?.executionStatus).toBe('QUEUED')
    // An admitted Extraction is paused, resumed, retried and stopped in Results, not started again.
    expect(result.current.canRun).toBe(false)
  })

  it('reports disabled admissions as a refusal that started nothing, and offers Run again', async () => {
    server({ post: () => Response.json({ error: { code: ADMISSIONS_DISABLED,
      message: 'Starting new Extractions is unavailable until the durable extraction release is verified. Nothing was started; saved Extractions remain available.' } }, { status: 409 }) })
    const { result, onMethodChanged, onError } = render()
    let acknowledged: ExtractionAttempt | null = attempt('placeholder')
    await act(async () => { acknowledged = await result.current.runExtraction(method, target) })
    expect(acknowledged).toBeNull()
    expect(onMethodChanged).toHaveBeenCalledWith(expect.stringContaining('Nothing was started'), ADMISSIONS_DISABLED)
    expect(onError).not.toHaveBeenCalled()
    expect(result.current.attempt).toBeNull()
    expect(result.current.monitorError).toBeNull()
    expect(result.current.canRun).toBe(true)
  })

  it('reports a superseded source without failing, and any other refusal with the server\'s words', async () => {
    let answer = Response.json({ error: { code: 'source_representation_superseded', message: 'Reprocessed.' } }, { status: 409 })
    server({ post: () => answer })
    const { result, onSuperseded, onError } = render()
    await act(async () => { await result.current.runExtraction(method, target) })
    expect(onSuperseded).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    answer = Response.json({ error: { code: 'invalid_request', message: 'The run was refused.' } }, { status: 422 })
    await act(async () => { await result.current.runExtraction(method, target) })
    expect(onError).toHaveBeenCalledWith('The run was refused.')
    expect(result.current.attempt).toBeNull()
  })

  it('reconciles an uncertain admission by reading the same identity, never by posting again', async () => {
    let readable = false
    const { posts, reads } = server({
      post: () => new Response('Bad gateway', { status: 502 }),
      read: (id) => readable ? Response.json({ extraction: attempt(id, 'PAUSED') }) : new Response('Bad gateway', { status: 502 }),
    })
    const { result } = render()
    await act(async () => { await result.current.runExtraction(method, target) })
    await waitFor(() => expect(result.current.monitorError).toBe(MONITOR_DISCONNECTED))
    expect(reads).toEqual([posts[0]!.id])
    readable = true
    await act(async () => { result.current.reconnect() })
    await waitFor(() => expect(result.current.attempt?.executionStatus).toBe('PAUSED'))
    expect(posts).toHaveLength(1)
    expect(reads).toEqual([posts[0]!.id, posts[0]!.id])
    expect(result.current.monitorError).toBeNull()
  })

  it('re-posts an unanswered request under its own identity, so admission can replay it', async () => {
    const { posts } = server({ post: () => new Response('Bad gateway', { status: 502 }), read: () => new Response('Bad gateway', { status: 502 }) })
    const { result } = render()
    await act(async () => { await result.current.runExtraction(method, target) })
    await waitFor(() => expect(result.current.monitorError).toBe(MONITOR_DISCONNECTED))
    await act(async () => { await result.current.runExtraction(method, target) })
    expect(posts).toHaveLength(2)
    expect(posts[1]!.id).toBe(posts[0]!.id)
  })

  it('says when the monitored Extraction is not found or not the researcher\'s', async () => {
    server({ post: () => new Response('Bad gateway', { status: 502 }), read: () => Response.json({ error: { code: 'not_found', message: 'gone' } }, { status: 404 }) })
    const { result } = render()
    await act(async () => { await result.current.runExtraction(method, target) })
    await waitFor(() => expect(result.current.monitorError).toBe(EXTRACTION_UNAVAILABLE))
  })
})

describe('durable status ownership', () => {
  it('hands status to the durable reader, which stops the monitor and reports a terminal state once', async () => {
    const { reads } = server({ post: (body) => Response.json(attempt(body.id), { status: 201 }) })
    const { result, onTerminal } = render()
    await act(async () => { await result.current.runExtraction(method, target) })
    const id = result.current.attempt!.extractionId
    act(() => result.current.acceptDurableStatus(id, 'RUNNING'))
    expect(result.current.attempt?.executionStatus).toBe('RUNNING')
    act(() => result.current.acceptDurableStatus(id, 'COMPLETED'))
    act(() => result.current.acceptDurableStatus(id, 'COMPLETED'))
    expect(onTerminal).toHaveBeenCalledOnce()
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({ extractionId: id, executionStatus: 'COMPLETED' }), false)
    // The monitor was stopped before its first poll: the reader owns status.
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    expect(reads).toEqual([])
    expect(result.current.canRun).toBe(true)
  }, 5_000)

  it('ignores a status for another Extraction', () => {
    server({ post: (body) => Response.json(attempt(body.id), { status: 201 }) })
    const { result } = render({ initialAttempt: attempt('51000000-0000-4000-8006-000000000001', 'PAUSED') })
    act(() => result.current.acceptDurableStatus('51000000-0000-4000-8006-000000000002', 'COMPLETED'))
    expect(result.current.attempt?.executionStatus).toBe('PAUSED')
  })

  it('reseeds from the reopened Extraction when the document changes, and drops the previous monitor', async () => {
    const reopened = attempt('51000000-0000-4000-8006-000000000003', 'STOPPED')
    server({ post: (body) => Response.json(attempt(body.id), { status: 201 }) })
    const { result, rerender } = render()
    await act(async () => { await result.current.runExtraction(method, target) })
    expect(result.current.attempt?.executionStatus).toBe('QUEUED')
    rerender({ documentKey: 'another document', initialAttempt: reopened })
    expect(result.current.attempt).toEqual(reopened)
    expect(result.current.canRun).toBe(true)
  })

  it('polls a reopened active Extraction until the reader takes over', async () => {
    const reopened = attempt('51000000-0000-4000-8006-000000000004', 'RUNNING')
    const { reads } = server({ post: () => { throw new Error('No admission') }, read: (id) => Response.json({ extraction: attempt(id, 'PAUSED') }) })
    const { result } = render({ initialAttempt: reopened })
    await waitFor(() => expect(result.current.attempt?.executionStatus).toBe('PAUSED'), { timeout: 3_000 })
    expect(reads).toEqual([reopened.extractionId])
  }, 5_000)
})
