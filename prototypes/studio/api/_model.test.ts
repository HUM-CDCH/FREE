import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSchemaWithModel, generateStructuredWithModel } from './_model.js'

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

function stubOllamaResponse(response: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ response }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  try {
    return JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>
  } catch (error) {
    throw new Error('Structured model request body was not valid JSON', {
      cause: error,
    })
  }
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

describe('generateStructuredWithModel', () => {
  it('uses the raw NuExtract boundary and conforms the returned object', async () => {
    const fetchMock = stubOllamaResponse('{"title":"Report","extra":"drop"}')

    const result = await generateStructuredWithModel({
      document: 'Canonical report',
      schema: { title: '', count: 0 },
      instructions: 'Extract one report.',
    })

    expect(result).toEqual({ title: 'Report', count: null })
    const body = requestBody(fetchMock)
    expect(body.raw).toBe(true)
    expect(body.stream).toBe(false)
    expect(body.prompt).toContain('Extract one report.')
    expect(body.prompt).toContain('Canonical report')
  })

  it('routes codex-cli structured extraction through the existing generic model boundary', async () => {
    stubCodexResponse('{"title":"Report"}')

    const result = await generateStructuredWithModel({
      document: 'Canonical report',
      schema: { title: '' },
      instructions: 'Extract one report.',
    })

    expect(fetch).not.toHaveBeenCalled()
    expect(generateTextMock).toHaveBeenCalledOnce()
    expect(generateTextMock.mock.calls[0][0]).not.toHaveProperty('temperature')
    expect(result).toEqual({ title: 'Report' })
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
    const fetchMock = stubOllamaResponse('{"grave":[{"name":"verbatim-string"}]}')

    await generateSchemaWithModel({
      document,
      annotations: [],
      annotationsMode: 'hints',
    })

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
