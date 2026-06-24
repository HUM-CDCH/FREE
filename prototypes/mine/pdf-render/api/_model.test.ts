import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractWithModel, generateSchemaWithModel } from './_model'

const document = {
  file: null,
  markdown: 'Grave 1',
  pages: null,
}

function stubOllamaResponse(response: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ response }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  )
}

describe('extractWithModel', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns clean extraction results with mirrored evidence', async () => {
    stubOllamaResponse('{"grave":[{"name":{"value":"Grave 1","snippet":"Grave 1","page":1}}]}')

    const result = await extractWithModel({
      document,
      template: { grave: [{ name: 'verbatim-string' }] },
    })

    expect(result.result).toEqual({ grave: [{ name: 'Grave 1' }] })
    expect(result.evidence).toEqual({
      grave: [{ name: { value: 'Grave 1', snippet: 'Grave 1', page: 1 } }],
    })
  })

  it('rejects valid JSON with fields outside the extraction schema', async () => {
    stubOllamaResponse('{"grave":[{"name":"Grave 1","extra":"invented"}]}')

    await expect(
      extractWithModel({
        document,
        template: { grave: [{ name: 'verbatim-string' }] },
      }),
    ).rejects.toMatchObject({
      status: 502,
      message: 'Model returned output that did not match the extraction schema.',
    })
  })

  it('rejects valid JSON with primitive types outside the extraction schema', async () => {
    stubOllamaResponse('{"grave":[{"name":42}]}')

    await expect(
      extractWithModel({
        document,
        template: { grave: [{ name: 'verbatim-string' }] },
      }),
    ).rejects.toMatchObject({
      status: 502,
      message: 'Model returned output that did not match the extraction schema.',
    })
  })
})

describe('generateSchemaWithModel', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('repairs malformed Ollama JSON before returning the extraction schema', async () => {
    stubOllamaResponse('{"grave":[{"name":"verbatim-string"}}]')

    const result = await generateSchemaWithModel({
      document,
      annotations: [],
      annotationsMode: 'hints',
    })

    expect(result.template).toEqual({ grave: [{ name: 'verbatim-string' }] })
  })

  it('leads the prompt with schema guidance, before the document body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ response: '{"grave":[{"name":"verbatim-string"}]}' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await generateSchemaWithModel({ document, annotations: [], annotationsMode: 'hints' })

    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body as string).prompt as string
    expect(prompt.indexOf('compact JSON extraction schema')).toBeLessThan(prompt.indexOf('Grave 1'))
  })
})
