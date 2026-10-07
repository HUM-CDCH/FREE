import { afterEach, expect, it, vi } from 'vitest'
import { durableRequest, readDurableHistory } from './durableExtractionApi'

vi.mock('./auth/authenticatedFetch', () => ({
  authenticatedFetch: (...args: Parameters<typeof fetch>) => fetch(...args),
}))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('retries a history download interrupted after HTTP 200 and returns only the complete response', async () => {
  vi.useFakeTimers()
  const interrupted = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"snapshots":'))
    controller.error(new TypeError('Failed to fetch'))
  } }), { status: 200 })
  const fetcher = vi.fn().mockResolvedValueOnce(interrupted).mockResolvedValueOnce(Response.json({ snapshots: [] }))
  vi.stubGlobal('fetch', fetcher)
  const reading = readDurableHistory('extraction').then(value => ({ value }), error => ({ error }))
  await vi.runAllTimersAsync()
  expect(await reading).toEqual({ value: { snapshots: [] } })
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1])
})

it('does not replay writes when the connection fails', async () => {
  const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
  vi.stubGlobal('fetch', fetcher)
  await expect(durableRequest('/api/extractions/extraction/durable/finalize', { snapshotVersion: 1 })).rejects.toThrow('Failed to fetch')
  expect(fetcher).toHaveBeenCalledOnce()
})

it('limits failed reads to three attempts with increasing delays', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
  vi.stubGlobal('fetch', fetcher)
  const reading = readDurableHistory('extraction').catch(error => error)
  await vi.advanceTimersByTimeAsync(999)
  expect(fetcher).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(fetcher).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1999)
  expect(fetcher).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(await reading).toBeInstanceOf(TypeError)
})

it.each([401, 403, 500])('does not retry an HTTP %s error', async (status) => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { message: 'Request refused' } }, { status }))
  vi.stubGlobal('fetch', fetcher)
  await expect(readDurableHistory('extraction')).rejects.toThrow('Request refused')
  expect(fetcher).toHaveBeenCalledOnce()
})

it('does not retry malformed JSON', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('{'))
  vi.stubGlobal('fetch', fetcher)
  await expect(readDurableHistory('extraction')).rejects.toThrow(SyntaxError)
  expect(fetcher).toHaveBeenCalledOnce()
})

it('cancels backoff when a read is aborted', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
  vi.stubGlobal('fetch', fetcher)
  const reading = readDurableHistory('extraction', controller.signal).catch(error => error)
  await vi.advanceTimersByTimeAsync(0)
  controller.abort()
  await vi.runAllTimersAsync()
  expect((await reading).name).toBe('AbortError')
  expect(fetcher).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
