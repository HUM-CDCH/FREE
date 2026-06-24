import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeExtractDone,
  decodeMarkdownDone,
  decodeSchemaDone,
  requestExtraction,
  requestSchema,
} from './api'

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
        return Promise.resolve(jsonResponse({ result: {}, reasoning: null, raw: '', pages: null }))
      }),
    )

    await requestExtraction(new Blob(['pdf']), 'report.pdf', null)

    expect(submittedTemplate).toBe('{}')
  })

  it('throws the API detail on a non-OK response', async () => {
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

describe('requestSchema', () => {
  it('calls the schema generation endpoint', async () => {
    let submittedUrl = ''
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        submittedUrl = url
        return Promise.resolve(jsonResponse({ template: {}, raw: '', pages: null }))
      }),
    )

    await requestSchema(new Blob(['pdf']), 'report.pdf')

    expect(submittedUrl).toBe('/api/generate_schema')
  })
})

describe('decoders', () => {
  it('fail loud when response contracts drift', () => {
    expect(() => decodeExtractDone({ raw: '{}' })).toThrow("extract: response missing 'result'")
    expect(() => decodeSchemaDone({ raw: '{}' })).toThrow("generate_schema: response missing 'template'")
    expect(() => decodeMarkdownDone({ pages: null })).toThrow("markdown: response missing 'markdown'")
  })
})
