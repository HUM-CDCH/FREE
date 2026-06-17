import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamJsonl } from './jsonlStream'

/** Build a 200 Response whose body streams the given chunks verbatim. */
function streamOf(chunks: string[], init: ResponseInit = {}): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(enc.encode(chunk))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, ...init })
}

function mockFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
}

const identity = (data: unknown) => data

afterEach(() => vi.unstubAllGlobals())

describe('streamJsonl', () => {
  it('dispatches delta output and resolves with the decoded done payload', async () => {
    mockFetch(
      streamOf([
        '{"event":"delta","data":{"output":"foo"}}\n',
        '{"event":"done","data":{"message":"hi"}}\n',
      ]),
    )
    const onDelta = vi.fn()
    const result = await streamJsonl('/chat', new FormData(), { onDelta }, identity)
    expect(onDelta).toHaveBeenCalledWith('foo')
    expect(result).toEqual({ message: 'hi' })
  })

  it('throws the detail from an error event', async () => {
    mockFetch(streamOf(['{"event":"error","data":{"detail":"boom"}}\n']))
    await expect(
      streamJsonl('/extract', new FormData(), { onDelta: vi.fn() }, identity),
    ).rejects.toThrow('boom')
  })

  it('throws when the stream ends without a done event', async () => {
    mockFetch(streamOf(['{"event":"delta","data":{"output":"a"}}\n']))
    await expect(
      streamJsonl('/extract', new FormData(), { onDelta: vi.fn() }, identity),
    ).rejects.toThrow(/stream ended without a result/)
  })

  it('throws the response body text on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    await expect(
      streamJsonl('/extract', new FormData(), { onDelta: vi.fn() }, identity),
    ).rejects.toThrow('nope')
  })

  it('fires no further handlers once aborted, even for buffered lines', async () => {
    const ac = new AbortController()
    const onDelta = vi.fn(() => ac.abort())
    const decodeDone = vi.fn(identity)
    // All events arrive in ONE chunk, so they are buffered and dispatched
    // without a fresh read() — exactly the gap the abort guard must close.
    mockFetch(
      streamOf([
        '{"event":"delta","data":{"output":"a"}}\n' +
          '{"event":"delta","data":{"output":"b"}}\n' +
          '{"event":"done","data":{"v":1}}\n',
      ]),
    )
    await expect(
      streamJsonl('/extract', new FormData(), { onDelta }, decodeDone, ac.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(onDelta).toHaveBeenCalledTimes(1)
    expect(decodeDone).not.toHaveBeenCalled()
  })
})
