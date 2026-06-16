import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestExtraction } from './api'

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

afterEach(() => vi.unstubAllGlobals())

describe('requestExtraction', () => {
  it('posts a blank template object when the UI passes null', async () => {
    let submittedTemplate: FormDataEntryValue | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        submittedTemplate = init.body instanceof FormData ? init.body.get('template') : null
        return Promise.resolve(streamOf(['{"event":"done","data":{"result":{},"raw":"","pages":1}}\n']))
      }),
    )

    await requestExtraction(new Blob(['pdf']), 'report.pdf', null, vi.fn())

    expect(submittedTemplate).toBe('{}')
  })
})
