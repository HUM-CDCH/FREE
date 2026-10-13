// @vitest-environment jsdom
import { StrictMode } from 'react'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import { createDurableReader, useKeyedController, type DurableReader } from './durableReader'
import { EXTRACTION_UNAVAILABLE, MONITOR_DISCONNECTED } from './useExtraction'

const id = '51000000-0000-4000-8006-000000000001'
const root = `/api/extractions/${id}/durable`
const seed = (executionStatus: ExtractionAttempt['executionStatus'] = 'RUNNING', extractionId = id) =>
  ({ extractionId, executionStatus }) as ExtractionAttempt
const state = (status = 'RUNNING', controlVersion = 1, snapshotVersion = 1, feedbackVersion = 0) =>
  ({ extractionId: id, projectId: 'project', status, controlVersion, snapshotVersion, feedbackVersion, pendingResume: false })
const page = (snapshotVersion = 1) => ({ extractionId: id, snapshotVersion, feedbackVersion: 0, values: [], total: 0, next: null })

/** The server: `answer` replies to every request; each request's URL and signal are kept in order. */
function serve(answer: (url: string) => Response | Promise<Response>) {
  const requests: string[] = [], signals: AbortSignal[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(String(input))
    signals.push(init!.signal!)
    return answer(String(input))
  }))
  return { requests, signals, states: () => requests.filter(url => url === root).length }
}
let started: DurableReader | undefined
/** A reader with a subscriber (which starts it) recording each publication. */
function start(initial = seed()) {
  const reader = started = createDurableReader(initial), published = vi.fn()
  reader.subscribe(published)
  return { reader, published }
}
const flush = () => vi.advanceTimersByTimeAsync(0)
/** Pending answers, settled by the test. */
function held() {
  const answers: ((response: Response) => void)[] = []
  return { answers, answer: () => new Promise<Response>(resolve => answers.push(resolve)) }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  started?.dispose()
  started = undefined
  delete (document as { hidden?: boolean }).hidden
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('reads 1.5 s after each read while the run is live, then every 30 s and on focus once it settles', async () => {
  let status = 'RUNNING'
  const server = serve(() => Response.json(state(status)))
  start()
  await flush()
  expect(server.states()).toBe(1)
  await vi.advanceTimersByTimeAsync(1_500)
  expect(server.states()).toBe(2)
  status = 'PAUSED'
  await vi.advanceTimersByTimeAsync(1_500)
  expect(server.states()).toBe(3)
  await vi.advanceTimersByTimeAsync(29_000)
  expect(server.states()).toBe(3)
  window.dispatchEvent(new Event('focus'))
  await flush()
  expect(server.states()).toBe(4)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(server.states()).toBe(5)
})

it('reads nothing while the tab is hidden, and once when it shows again', async () => {
  let hidden = true
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  const server = serve(() => Response.json(state()))
  start()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(server.states()).toBe(0)
  hidden = false
  document.dispatchEvent(new Event('visibilitychange'))
  await flush()
  expect(server.states()).toBe(1)
  hidden = true
  await vi.advanceTimersByTimeAsync(60_000)
  expect(server.states()).toBe(1)
  hidden = false
  document.dispatchEvent(new Event('visibilitychange'))
  await flush()
  expect(server.states()).toBe(2)
  await vi.advanceTimersByTimeAsync(1_500)
  expect(server.states()).toBe(3)
})

it('stops a read the tab hides in the middle of, as no failure, and reads once when it shows again', async () => {
  let hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  const answers: ((response: Response) => void)[] = [], signals: AbortSignal[] = []
  // As fetch does, a request rejects once its signal aborts.
  vi.stubGlobal('fetch', vi.fn((_input: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    answers.push(resolve)
    signals.push(init!.signal!)
    init!.signal!.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
  })))
  const { reader } = start()
  await flush()
  const refreshed = reader.refresh()
  hidden = true
  document.dispatchEvent(new Event('visibilitychange'))
  await flush()
  expect(signals[0]!.aborted).toBe(true)
  expect(reader.snapshot()).toMatchObject({ connection: 'connected', error: null })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(answers).toHaveLength(1)
  hidden = false
  document.dispatchEvent(new Event('visibilitychange'))
  await flush()
  expect(answers).toHaveLength(2)
  answers[1]!(Response.json(state()))
  await refreshed
  expect(reader.snapshot().state).toMatchObject({ status: 'RUNNING' })
})

it('keeps a Reconnect the tab hides in the middle of, and reads it once the tab shows again', async () => {
  let hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  const answers: ((response: Response) => void)[] = []
  vi.stubGlobal('fetch', vi.fn((_input: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    answers.push(resolve)
    init!.signal!.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
  })))
  const { reader } = start()
  await flush()
  answers[0]!(Response.json({ error: { message: 'Not found.', code: 'not_found' } }, { status: 404 }))
  await flush()
  expect(reader.snapshot().connection).toBe('failed')
  const reconnected = reader.refresh()
  await flush()
  hidden = true
  document.dispatchEvent(new Event('visibilitychange'))
  await flush()
  hidden = false
  document.dispatchEvent(new Event('visibilitychange'))
  await flush()
  expect(answers).toHaveLength(3)
  answers[2]!(Response.json(state()))
  await reconnected
  expect(reader.snapshot()).toMatchObject({ connection: 'connected', state: { status: 'RUNNING' } })
})

it('resumes a read the tab hid and showed again before its abort landed', async () => {
  let hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  const answers: ((response: Response) => void)[] = []
  // The abort lands later than the tab shows again, as a response body's abort can.
  vi.stubGlobal('fetch', vi.fn((_input: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    answers.push(resolve)
    init!.signal!.addEventListener('abort', () => setTimeout(() => reject(new DOMException('The operation was aborted.', 'AbortError')), 10))
  })))
  const { reader } = start()
  await flush()
  const refreshed = reader.refresh()
  hidden = true
  document.dispatchEvent(new Event('visibilitychange'))
  hidden = false
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(10)
  expect(answers).toHaveLength(2)
  answers[1]!(Response.json(state()))
  await refreshed
  expect(reader.snapshot().state).toMatchObject({ status: 'RUNNING' })
})

it('schedules nothing once a subscriber disposes the reader while it publishes', async () => {
  serve(() => Response.json(state()))
  const reader = started = createDurableReader(seed())
  reader.subscribe(() => { if (reader.snapshot().state) reader.dispose() })
  await flush()
  expect(reader.snapshot().state).toMatchObject({ status: 'RUNNING' })
  expect(vi.getTimerCount()).toBe(0)
})

it('reads the latest values only while a consumer wants them', async () => {
  let current = state('RUNNING', 1, 1)
  const server = serve(url => Response.json(url === root ? current : page(current.snapshotVersion)))
  const { reader } = start()
  await flush()
  expect(server.requests).toEqual([root])
  const release = reader.wantPages()
  await flush()
  expect(server.requests).toEqual([root, root, `${root}/values?limit=500&snapshotVersion=1`])
  expect(reader.snapshot().latestPage).toMatchObject({ snapshotVersion: 1 })
  release()
  current = state('RUNNING', 1, 2)
  await vi.advanceTimersByTimeAsync(1_500)
  expect(server.requests.at(-1)).toBe(root)
  expect(reader.snapshot()).toMatchObject({ state: { snapshotVersion: 2 }, latestPage: { snapshotVersion: 1 } })
})

it('finishes a values read its consumer releases midway, then reads the state only', async () => {
  let current = state('RUNNING', 1, 1)
  const values = held()
  const server = serve(url => url === root ? Response.json(current) : values.answer())
  const { reader } = start()
  const release = reader.wantPages()
  await flush()
  expect(server.requests).toEqual([root, `${root}/values?limit=500&snapshotVersion=1`])
  release()
  values.answers[0]!(Response.json(page(1)))
  await flush()
  expect(reader.snapshot().latestPage).toMatchObject({ snapshotVersion: 1 })
  current = state('RUNNING', 1, 2)
  await vi.advanceTimersByTimeAsync(1_500)
  expect(server.requests.slice(2)).toEqual([root])
  expect(reader.snapshot()).toMatchObject({ state: { snapshotVersion: 2 }, latestPage: { snapshotVersion: 1 } })
})

it('publishes the state when the values read after it fails, and keeps the values read before', async () => {
  let current = state('RUNNING', 1, 1), values = () => Response.json(page(1))
  serve(url => url === root ? Response.json(current) : values())
  const { reader } = start()
  reader.wantPages()
  await flush()
  const before = reader.snapshot().latestPage
  current = state('COMPLETED', 1, 2)
  values = () => new Response('<html>Bad gateway</html>', { status: 502 })
  await vi.advanceTimersByTimeAsync(1_500)
  expect(reader.snapshot()).toMatchObject({ state: { status: 'COMPLETED', snapshotVersion: 2 }, latestPage: before,
    pageError: 'Request failed (HTTP 502).', connection: 'connected', error: null })
  values = () => Response.json(page(2))
  await reader.refresh()
  expect(reader.snapshot()).toMatchObject({ latestPage: { snapshotVersion: 2 }, pageError: null })
})

it('reads on with backoff after a gateway error or a rate limit, and stops on a refusal or a body that is no state', async () => {
  let answer = () => Response.json(state())
  const server = serve(() => answer())
  const { reader } = start()
  await flush()
  const accepted = reader.snapshot().state
  answer = () => new Response('<html>Bad gateway</html>', { status: 502 })
  await vi.advanceTimersByTimeAsync(1_500)
  expect(reader.snapshot()).toMatchObject({ state: accepted, connection: 'reconnecting', error: MONITOR_DISCONNECTED })
  answer = () => Response.json({ error: { message: 'Slow down.' } }, { status: 429 })
  await vi.advanceTimersByTimeAsync(1_500)
  expect(server.states()).toBe(3)
  expect(reader.snapshot()).toMatchObject({ state: accepted, connection: 'reconnecting' })
  // A second failure in a row waits twice as long.
  await vi.advanceTimersByTimeAsync(1_500)
  expect(server.states()).toBe(3)
  answer = () => Response.json(state())
  await vi.advanceTimersByTimeAsync(1_500)
  expect(reader.snapshot()).toMatchObject({ state: accepted, connection: 'connected', error: null })
  answer = () => Response.json({ error: { code: 'not_found', message: 'Gone.' } }, { status: 404 })
  await vi.advanceTimersByTimeAsync(1_500)
  expect(reader.snapshot()).toMatchObject({ state: accepted, connection: 'failed', error: EXTRACTION_UNAVAILABLE })
  const failedAt = server.states()
  await vi.advanceTimersByTimeAsync(60_000)
  window.dispatchEvent(new Event('focus'))
  await flush()
  expect(server.states()).toBe(failedAt)
  // Only a manual re-read tries again.
  answer = () => Response.json({ status: 'RUNNING' })
  await reader.refresh()
  expect(reader.snapshot()).toMatchObject({ state: accepted, connection: 'failed', error: 'The saved results could not be read.' })
  answer = () => Response.json(state())
  await reader.refresh()
  expect(reader.snapshot()).toMatchObject({ connection: 'connected', error: null })
})

it('reports a settled run\'s transient failure without saying it may still be running', async () => {
  let answer = () => Response.json(state('PAUSED'))
  serve(() => answer())
  const { reader } = start(seed('PAUSED'))
  await flush()
  answer = () => new Response('<html>Bad gateway</html>', { status: 502 })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(reader.snapshot()).toMatchObject({ connection: 'reconnecting', error: 'Unable to update saved results.' })
})

it('publishes the state before a slow values read answers', async () => {
  const values = held()
  serve(url => url === root ? Response.json(state('COMPLETED', 1, 2)) : values.answer())
  const { reader } = start()
  reader.wantPages()
  await flush()
  expect(reader.snapshot()).toMatchObject({ state: { status: 'COMPLETED', snapshotVersion: 2 }, latestPage: null })
  values.answers[0]!(Response.json(page(2)))
  await flush()
  expect(reader.snapshot()).toMatchObject({ latestPage: { snapshotVersion: 2 } })
})

it('lets no read older than a receipt land, also before the first observation', async () => {
  const states = held()
  serve(url => url === root ? states.answer() : Response.json(page(1)))
  const { reader } = start()
  await flush()
  reader.acceptReceipt({ controlVersion: 2, status: 'STOPPING', pendingResume: false })
  states.answers[0]!(Response.json(state('RUNNING', 1)))
  await flush()
  expect(reader.snapshot().state).toBeNull()
  const refreshed = reader.refresh()
  await flush()
  states.answers[1]!(Response.json(state('STOPPING', 2)))
  await refreshed
  expect(reader.snapshot().state).toMatchObject({ status: 'STOPPING', controlVersion: 2 })
})

it('drops a read older than the state it holds', async () => {
  let current = state('STOPPED', 3)
  serve(() => Response.json(current))
  const { reader } = start(seed('STOPPING'))
  await flush()
  current = state('STOPPING', 2)
  await reader.refresh()
  expect(reader.snapshot().state).toMatchObject({ status: 'STOPPED', controlVersion: 3 })
})

it('takes a control receipt only when it is newer than the state it holds', async () => {
  let current = state('STOPPED', 3)
  serve(() => Response.json(current))
  const { reader } = start(seed('STOPPING'))
  await flush()
  const observed = reader.snapshot()
  // Stop's answer arrives after the read that saw it stop: a worker never moves the version, so the read holds it.
  reader.acceptReceipt({ controlVersion: 3, status: 'STOPPING', pendingResume: false })
  expect(reader.snapshot()).toBe(observed)
  reader.acceptReceipt({ controlVersion: 4, status: 'QUEUED', pendingResume: false })
  expect(reader.snapshot().state).toMatchObject({ status: 'QUEUED', controlVersion: 4 })
  current = state('STOPPED', 3)
  await reader.refresh()
  expect(reader.snapshot().state).toMatchObject({ status: 'QUEUED', controlVersion: 4 })
})

it('publishes only a change, so an equal read keeps the reading\'s identity', async () => {
  serve(() => Response.json(state('PAUSED')))
  const { reader, published } = start(seed('PAUSED'))
  await flush()
  const first = reader.snapshot()
  await reader.refresh()
  await reader.refresh()
  expect(reader.snapshot()).toBe(first)
  expect(published).toHaveBeenCalledOnce()
})

it('answers refresh() with one read started after it, never the read in flight', async () => {
  const pending = held()
  const server = serve(pending.answer)
  const { reader } = start(seed('PAUSED'))
  await flush()
  expect(server.states()).toBe(1)
  let refreshed = false
  const refreshing = reader.refresh().then(() => { refreshed = true })
  void reader.refresh()
  window.dispatchEvent(new Event('focus'))
  await flush()
  expect(server.states()).toBe(1)
  pending.answers[0]!(Response.json(state('PAUSED', 1)))
  await flush()
  expect(refreshed).toBe(false)
  expect(server.states()).toBe(2)
  pending.answers[1]!(Response.json(state('PAUSED', 2)))
  await refreshing
  expect(reader.snapshot().state).toMatchObject({ controlVersion: 2 })
  await flush()
  expect(server.states()).toBe(2)
})

// The workspace replaces the latest Extraction's reader when a reopened one replaces it (useExtraction's late read).
it('stops a replaced reader: its read is aborted, its late answer ignored, and it reads no more', async () => {
  const pending = held(), server = serve(pending.answer)
  const other = '51000000-0000-4000-8006-000000000099'
  const { result, rerender } = renderHook(({ attempt }) => useKeyedController(attempt.extractionId, () => createDurableReader(attempt)),
    { initialProps: { attempt: seed('QUEUED') } })
  const first = result.current!, published = vi.fn()
  first.subscribe(published)
  await flush()
  expect(server.requests).toEqual([root])
  rerender({ attempt: seed('PAUSED', other) })
  await flush()
  expect(server.signals[0]!.aborted).toBe(true)
  expect(result.current).not.toBe(first)
  pending.answers[0]!(Response.json(state('COMPLETED')))
  await vi.advanceTimersByTimeAsync(60_000)
  window.dispatchEvent(new Event('focus'))
  await flush()
  expect(published).not.toHaveBeenCalled()
  expect(first.snapshot().state).toBeNull()
  expect(server.requests).toEqual([root])
  result.current!.dispose()
})

it('keeps one controller per key through StrictMode\'s replay, and disposes it once replaced or unmounted', async () => {
  const made: { key: string; dispose: () => void }[] = []
  const { result, rerender, unmount } = renderHook(({ key }) => useKeyedController(key, () => {
    const controller = { key, dispose: vi.fn() }
    made.push(controller)
    return controller
  }), { initialProps: { key: 'a' }, wrapper: StrictMode })
  await flush()
  expect(made.map(each => each.key)).toEqual(['a'])
  expect(result.current).toBe(made[0])
  expect(made[0]!.dispose).not.toHaveBeenCalled()
  rerender({ key: 'b' })
  await flush()
  expect(made.map(each => each.key)).toEqual(['a', 'b'])
  expect(result.current).toBe(made[1])
  expect(made[0]!.dispose).toHaveBeenCalledOnce()
  unmount()
  await flush()
  expect(made[1]!.dispose).toHaveBeenCalledOnce()
})

it('gives a key a new controller when it comes back after none', async () => {
  const made: { key: string; dispose: () => void }[] = []
  const { result, rerender } = renderHook(({ key }: { key: string | null }) => useKeyedController(key, () => {
    const controller = { key: key!, dispose: vi.fn() }
    made.push(controller)
    return controller
  }), { initialProps: { key: 'a' as string | null }, wrapper: StrictMode })
  await flush()
  rerender({ key: null })
  await flush()
  expect(result.current).toBeNull()
  expect(made[0]!.dispose).toHaveBeenCalledOnce()
  rerender({ key: 'a' })
  await flush()
  expect(made).toHaveLength(2)
  expect(result.current).toBe(made[1])
  expect(made[1]!.dispose).not.toHaveBeenCalled()
})
