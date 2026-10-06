// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import { EXTRACTION_UNAVAILABLE, MONITOR_DISCONNECTED, useExtraction } from './useExtraction'

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
  read?: (id: string, signal: AbortSignal | undefined) => Response | Promise<Response>
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
      return read ? read(id, init?.signal ?? undefined) : Response.json({ extraction: attempt(id, 'RUNNING') })
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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

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

  it('acknowledges durable admission with its queued identity', async () => {
    server({ post: body => Response.json(attempt(body.id), { status: 201 }) })
    const { result, onMethodChanged, onError } = render()
    let acknowledged: ExtractionAttempt | null = null
    await act(async () => { acknowledged = await result.current.runExtraction(method, target) })
    expect(acknowledged).toMatchObject({ executionStatus: 'QUEUED' })
    expect(onMethodChanged).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(result.current.attempt).toEqual(acknowledged)
    expect(result.current.monitorError).toBeNull()
    expect(result.current.canRun).toBe(false)
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
    expect(result.current.retryAdmission).not.toBeNull()
    await act(async () => { await result.current.retryAdmission!() })
    expect(posts).toHaveLength(2)
    expect(posts[1]!.id).toBe(posts[0]!.id)
  })

  it('blocks a changed request while admission of the original identity is uncertain', async () => {
    const { posts } = server({ post: () => new Response('Bad gateway', { status: 502 }), read: () => new Response('Bad gateway', { status: 502 }) })
    const { result } = render({ initialAttempt: attempt('51000000-0000-4000-8006-000000000005', 'COMPLETED') })
    await act(async () => { await result.current.runExtraction(method, target, 'ARTICLE', null, 1) })
    await waitFor(() => expect(result.current.monitorError).toBe(MONITOR_DISCONNECTED))
    expect(result.current.canRun).toBe(false)
    await act(async () => { await result.current.runExtraction(method, target, 'ARTICLE', null, 2) })
    expect(posts).toHaveLength(1)
  })

  it.each(['PAUSED', 'FAILED', 'PAUSING', 'STOPPING'] as const)('does not admit a new Extraction while the latest is %s', async (status) => {
    const { posts } = server({ post: (body) => Response.json(attempt(body.id), { status: 201 }) })
    const { result } = render({ initialAttempt: attempt('51000000-0000-4000-8006-000000000005', status) })
    expect(result.current.canRun).toBe(false)
    await act(async () => { await result.current.runExtraction(method, target) })
    expect(posts).toEqual([])
  })

  it('says when the monitored Extraction is not found or not the researcher\'s', async () => {
    server({ post: () => new Response('Bad gateway', { status: 502 }), read: () => Response.json({ error: { code: 'not_found', message: 'gone' } }, { status: 404 }) })
    const { result } = render()
    await act(async () => { await result.current.runExtraction(method, target) })
    await waitFor(() => expect(result.current.monitorError).toBe(EXTRACTION_UNAVAILABLE))
  })
})

describe('durable status ownership', () => {
  it('shares durable status updates and stops the active monitor only once work becomes idle', async () => {
    vi.useFakeTimers()
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
    // The terminal reader update stops the workspace monitor before its first poll.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
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

  it.each(['acknowledged', 'uncertain'] as const)('keeps a replacement initialAttempt on the same document after a late %s admission read', async (admission) => {
    vi.useFakeTimers()
    let finishRead!: (response: Response) => void
    const pendingRead = new Promise<Response>(resolve => { finishRead = resolve })
    let oldSignal: AbortSignal | undefined
    const { posts, reads } = server({
      post: body => admission === 'acknowledged' ? Response.json(attempt(body.id), { status: 201 }) : new Response('Bad gateway', { status: 502 }),
      read: (_id, signal) => { oldSignal = signal; return pendingRead },
    })
    const { result, rerender, onTerminal } = render()
    await act(async () => { await result.current.runExtraction(method, target) })
    if (admission === 'acknowledged') await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(reads).toEqual([posts[0]!.id])
    expect(oldSignal?.aborted).toBe(false)
    const replacement = attempt('51000000-0000-4000-8006-000000000099', 'PAUSED')
    rerender({ initialAttempt: replacement })
    expect(result.current.attempt).toEqual(replacement)
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => { finishRead(Response.json({ extraction: attempt(posts[0]!.id, 'COMPLETED') })) })
    expect(result.current.attempt).toEqual(replacement)
    expect(result.current.monitorError).toBeNull()
    expect(onTerminal).not.toHaveBeenCalled()
  })

  it('polls a reopened active Extraction until work becomes idle', async () => {
    const reopened = attempt('51000000-0000-4000-8006-000000000004', 'RUNNING')
    const { reads } = server({ post: () => { throw new Error('No admission') }, read: (id) => Response.json({ extraction: attempt(id, 'PAUSED') }) })
    const { result } = render({ initialAttempt: reopened })
    await waitFor(() => expect(result.current.attempt?.executionStatus).toBe('PAUSED'), { timeout: 3_000 })
    expect(reads).toEqual([reopened.extractionId])
  }, 5_000)
})
