import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractWithModel, generateSchemaWithModel } from './_model.js'

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }))

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: generateTextMock }
})

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

function stubCodexResponse(response: string): void {
  vi.stubEnv('AI_PROVIDER', 'codex-cli')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Ollama must not be called')))
  generateTextMock.mockResolvedValue({ text: response })
}

beforeEach(() => vi.stubEnv('AI_PROVIDER', 'ollama'))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  generateTextMock.mockReset()
})

describe('extractWithModel', () => {
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

  it('warns but keeps valid JSON with fields outside the extraction schema', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubOllamaResponse('{"grave":[{"name":"Grave 1","extra":"invented"}]}')

    const result = await extractWithModel({
      document,
      template: { grave: [{ name: 'verbatim-string' }] },
    })

    expect(result.result).toEqual({ grave: [{ name: 'Grave 1', extra: 'invented' }] })
    expect(warn).toHaveBeenCalledWith(
      'Model returned output that did not match the extraction schema.',
      expect.anything(),
    )
    warn.mockRestore()
  })

  it('warns but keeps valid JSON with primitive types outside the extraction schema', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubOllamaResponse('{"grave":[{"name":42}]}')

    const result = await extractWithModel({
      document,
      template: { grave: [{ name: 'verbatim-string' }] },
    })

    expect(result.result).toEqual({ grave: [{ name: 42 }] })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('routes codex-cli extraction through the AI SDK instead of Ollama', async () => {
    stubCodexResponse('{"grave":[{"name":{"value":"Grave 1","snippet":"Grave 1","page":1}}]}')

    const result = await extractWithModel({
      document,
      template: { grave: [{ name: 'verbatim-string' }] },
    })

    expect(fetch).not.toHaveBeenCalled()
    expect(generateTextMock).toHaveBeenCalledOnce()
    expect(generateTextMock.mock.calls[0][0]).not.toHaveProperty('temperature')
    expect(result.result).toEqual({ grave: [{ name: 'Grave 1' }] })
  })
})

describe('generateSchemaWithModel', () => {
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

    const body = fetchMock.mock.calls[0][1].body as string
    expect(body.indexOf('compact JSON extraction schema')).toBeLessThan(body.indexOf('Grave 1'))
  })

  it('routes codex-cli schema suggestions through the AI SDK', async () => {
    stubCodexResponse('{"grave":[{"name":"verbatim-string"}]}')

    const result = await generateSchemaWithModel({
      document,
      annotations: [],
      annotationsMode: 'hints',
    })

    expect(fetch).not.toHaveBeenCalled()
    expect(generateTextMock).toHaveBeenCalledOnce()
    expect(result.template).toEqual({ grave: [{ name: 'verbatim-string' }] })
  })
})
