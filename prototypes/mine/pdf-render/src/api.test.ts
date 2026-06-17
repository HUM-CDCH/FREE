import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestExtraction } from './api'

/** A buffered 200 JSON response, the shape /extract now returns. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('requestExtraction', () => {
  it('posts a blank template object when the UI passes null', async () => {
    let submittedTemplate: FormDataEntryValue | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        submittedTemplate = init.body instanceof FormData ? init.body.get('template') : null
        return Promise.resolve(jsonResponse({ result: {}, reasoning: null, raw: '', pages: 1 }))
      }),
    )

    await requestExtraction(new Blob(['pdf']), 'report.pdf', null)

    expect(submittedTemplate).toBe('{}')
  })

  it('throws the backend detail on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Model endpoint error: boom' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )

    await expect(requestExtraction(new Blob(['pdf']), 'report.pdf', {})).rejects.toThrow(
      'Model endpoint error: boom',
    )
  })
})
