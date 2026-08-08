import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import {
  generateSchemaEditJson,
  extractWithModel,
  generateSchemaWithModel,
  renderNuExtractPrompt,
  streamChatWithModel,
} from './_model.js'
import type { ExecutionTarget } from './_provider.js'
import {
  DELETE as clearLlmInspector,
  GET as getLlmInspector,
  type LlmTrace,
} from './llm_inspector.js'

const { generateTextMock, streamTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  streamTextMock: vi.fn(),
}))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: generateTextMock, streamText: streamTextMock }
})

const document = { file: null, markdown: 'Grave 1', pages: null }
const rawTarget: ExecutionTarget = {
  profile: 'nuextract-raw',
  modelId: 'nuextract/manual',
  baseUrl: 'http://127.0.0.1:11434',
  authorization: 'Bearer secret',
  temperatureSupported: true,
}
const generalTarget: ExecutionTarget = {
  profile: 'general',
  model: {
    specificationVersion: 'v4',
    provider: 'test-provider',
    modelId: 'test-model',
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  },
  jsonOutput: 'prompt',
  temperatureSupported: false,
}

function mockGeneration(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 20, text: 20, reasoning: undefined },
    },
    warnings: [],
  }
}

function schemaRecord(schema: unknown): Record<string, unknown> {
  return schema as Record<string, unknown>
}

function stubOllamaResponses(...generations: readonly {
  readonly response: string
  readonly doneReason?: string
}[]) {
  const request = vi.fn()
  for (const generation of generations) {
    request.mockResolvedValueOnce(
      new Response(JSON.stringify({
        response: generation.response,
        done_reason: generation.doneReason ?? 'stop',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
  vi.stubGlobal('fetch', request)
  return request
}

function stubOllamaResponse(response: string, doneReason = 'stop') {
  return stubOllamaResponses({ response, doneReason })
}

afterEach(() => {
  vi.unstubAllGlobals()
  generateTextMock.mockReset()
  clearLlmInspector()
})

describe('extractWithModel', () => {
  it('preserves raw NuExtract transport fields without model-generated evidence', async () => {
    const request = stubOllamaResponse(
      '{"grave":[{"name":"Grave 1"}]}',
    )
    const result = await extractWithModel(
      { document, template: { grave: [{ name: 'verbatim-string' }] } },
      rawTarget,
    )

    expect(result.result).toEqual({ grave: [{ name: 'Grave 1' }] })
    expect(result).not.toHaveProperty('evidence')
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: expect.any(String),
    })
    const body = JSON.parse(request.mock.calls[0][1].body as string)
    expect(body).toMatchObject({
      model: 'nuextract/manual',
      raw: true,
      stream: false,
      options: { temperature: 0.2 },
    })
    expect(body).not.toHaveProperty('chat_template_kwargs')
    expect(body.prompt).toContain('"name": "verbatim-string"')
    expect(body.prompt).not.toContain('_evidence')
    const inspector = await getLlmInspector().json() as { traces: LlmTrace[] }
    expect(inspector.traces[0]).toMatchObject({
      operation: 'extraction',
      provider: 'ollama',
      model: 'nuextract/manual',
      status: 'complete',
    })
    expect(inspector.traces[0].request).toContain('【task】structured')
    expect(inspector.traces[0].request).not.toContain('Bearer secret')
    expect(inspector.traces[0].response).toContain('Grave 1')
  })

  it('rejects invalid output without retrying', async () => {
    const request = stubOllamaResponses({ response: '[]', doneReason: 'stop' })
    await expect(extractWithModel(
      {
        document,
        template: { grave: [{ name: 'verbatim-string' }] },
        instruction: 'Keep exact names.',
      },
      rawTarget,
    )).rejects.toMatchObject({ code: 'invalid_model_output' })

    expect(request).toHaveBeenCalledOnce()
    const body = JSON.parse(request.mock.calls[0][1].body as string)
    expect(body.prompt).not.toContain('_evidence')
    expect(body.prompt).toContain('Keep exact names.')
  })

  it('preserves a parseable length-stopped partial without retrying', async () => {
    const request = stubOllamaResponses({
      response: '{"grave":[{"name":"Repeated"}]}',
      doneReason: 'length',
    })

    const result = await extractWithModel(
      { document, template: { grave: [{ name: 'verbatim-string' }] } },
      rawTarget,
    )

    expect(request).toHaveBeenCalledOnce()
    expect(result.result).toEqual({ grave: [{ name: 'Repeated' }] })
    expect(result).not.toHaveProperty('evidence')
  })

  it('preserves a path-prefixed Ollama server base for raw generation', async () => {
    const request = stubOllamaResponse(
      '{"grave":[{"name":"Grave 1"}]}',
    )
    await extractWithModel(
      { document, template: { grave: [{ name: 'verbatim-string' }] } },
      { ...rawTarget, baseUrl: 'https://gateway.example/ollama/' },
    )

    expect(request).toHaveBeenCalledWith(
      'https://gateway.example/ollama/api/generate',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('keeps parseable schema-mismatched extraction output', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubOllamaResponse('{"grave":[{"name":"Grave 1","extra":"invented"}]}')
    const result = await extractWithModel(
      { document, template: { grave: [{ name: 'verbatim-string' }] } },
      rawTarget,
    )
    expect(result.result).toEqual({ grave: [{ name: 'Grave 1', extra: 'invented' }] })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('uses direct general execution without calling Ollama', async () => {
    const request = vi.fn().mockRejectedValue(new Error('raw transport must not run'))
    vi.stubGlobal('fetch', request)
    generateTextMock.mockResolvedValue({
      text: '{"grave":[{"name":"Grave 1"}]}',
    })
    const result = await extractWithModel(
      { document, template: { grave: [{ name: 'verbatim-string' }] } },
      generalTarget,
    )
    expect(request).not.toHaveBeenCalled()
    expect(generateTextMock.mock.calls[0][0]).not.toHaveProperty('temperature')
    expect(generateTextMock.mock.calls[0][0]).toHaveProperty('reasoning', 'none')
    const instructions = generateTextMock.mock.calls[0][0].instructions as string
    expect(instructions).not.toContain('_evidence')
    expect(instructions).not.toContain('source evidence')
    expect(result.result).toEqual({ grave: [{ name: 'Grave 1' }] })
    expect(result).not.toHaveProperty('evidence')
  })

  it('uses native JSON output without changing the Extraction Schema', async () => {
    const { generateText } = await vi.importActual<typeof import('ai')>('ai')
    generateTextMock.mockImplementation(generateText)
    const rawOutput = JSON.stringify({
      records: [{
        grave_number: 8,
        skeleton: {
          preservation: 'Jaw fragment',
          parts: [{
            number: '8-1',
            description: 'Jaw and teeth',
          }],
        },
      }],
    })
    const doGenerate = vi.fn<(options: unknown) => Promise<ReturnType<typeof mockGeneration>>>(
      async () => mockGeneration(rawOutput),
    )
    const target: ExecutionTarget = {
      ...generalTarget,
      model: new MockLanguageModelV4({ doGenerate }),
      jsonOutput: 'native',
    }
    const result = await extractWithModel(
      {
        document,
        template: {
          records: [{
            grave_number: 'integer',
            skeleton: {
              preservation: 'verbatim-string',
              parts: [{ number: 'string', description: 'string' }],
            },
          }],
        },
      },
      target,
    )

    const responseFormat = schemaRecord(doGenerate.mock.calls[0][0]).responseFormat as {
      type?: string
      schema?: unknown
    } | undefined
    expect(responseFormat).toEqual({ type: 'json' })
    expect(result.result).toMatchObject({ records: [{ grave_number: 8 }] })
    expect(result.raw).toBe(rawOutput)
    expect(result).not.toHaveProperty('evidence')
  })

  it('repairs and preserves partial native extraction results', async () => {
    const { generateText } = await vi.importActual<typeof import('ai')>('ai')
    generateTextMock.mockImplementation(generateText)
    const doGenerate = vi.fn<(options: unknown) => Promise<ReturnType<typeof mockGeneration>>>(
      async () => mockGeneration('{"records":[{"grave_number":8}]} trailing'),
    )
    const target: ExecutionTarget = {
      ...generalTarget,
      model: new MockLanguageModelV4({ doGenerate }),
      jsonOutput: 'native',
    }

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await extractWithModel({
      document,
      template: { records: [{ grave_number: 'integer', note: 'string' }] },
    }, target)

    expect(result.result).toEqual({ records: [{ grave_number: 8 }] })
    expect(result).not.toHaveProperty('evidence')
    expect(warning).toHaveBeenCalledOnce()
    expect(doGenerate).toHaveBeenCalledOnce()
  })

  it('does not send a response schema to prompt-only providers', async () => {
    const { generateText } = await vi.importActual<typeof import('ai')>('ai')
    generateTextMock.mockImplementation(generateText)
    const doGenerate = vi.fn<(options: unknown) => Promise<ReturnType<typeof mockGeneration>>>(
      async () => mockGeneration(
        '{"grave":[{"name":"Grave 1"}]}',
      ),
    )
    await extractWithModel(
      { document, template: { grave: [{ name: 'verbatim-string' }] } },
      { ...generalTarget, model: new MockLanguageModelV4({ doGenerate }) },
    )

    expect(schemaRecord(doGenerate.mock.calls[0][0]).responseFormat).toBeUndefined()
  })
})

describe('generateSchemaWithModel', () => {
  it('repairs generated model JSON on the raw path', async () => {
    stubOllamaResponse('{"grave":[{"name":"verbatim-string"}}]')
    const result = await generateSchemaWithModel(
      { document, annotations: [], annotationsMode: 'hints' },
      rawTarget,
    )
    expect(result.template).toEqual({ grave: [{ name: 'verbatim-string' }] })
  })

  it('leads the raw template-generation message with schema guidance', async () => {
    const request = stubOllamaResponse('{"grave":[{"name":"verbatim-string"}]}')
    await generateSchemaWithModel(
      { document, annotations: [], annotationsMode: 'hints' },
      rawTarget,
    )
    const body = request.mock.calls[0][1].body as string
    expect(body.indexOf('compact JSON extraction schema')).toBeLessThan(body.indexOf('Grave 1'))
    expect(body).not.toContain('【instructions_start】')
  })

  it('uses the selected general target for schema suggestion', async () => {
    generateTextMock.mockResolvedValue({ text: '{"grave":[{"name":"verbatim-string"}]}' })
    const result = await generateSchemaWithModel(
      { document, annotations: [], annotationsMode: 'hints' },
      generalTarget,
    )
    expect(generateTextMock).toHaveBeenCalledOnce()
    expect(result.template).toEqual({ grave: [{ name: 'verbatim-string' }] })
  })
})

describe('interactive model operations', () => {
  it('uses prompted JSON without structured output on a prompt route', async () => {
    generateTextMock.mockResolvedValue({ text: '{"fields":{},"additions":[]}', finishReason: 'stop' })

    const result = await generateSchemaEditJson('schema prompt', undefined, generalTarget)

    expect(generateTextMock.mock.calls[0][0]).toMatchObject({
      reasoning: 'none',
      messages: [{ role: 'user', content: 'schema prompt' }],
    })
    expect(generateTextMock.mock.calls[0][0]).not.toHaveProperty('output')
    expect(result.text).toBe('{"fields":{},"additions":[]}')
  })

  it('requests bounded JSON with reasoning disabled on a native route', async () => {
    generateTextMock.mockResolvedValue({ text: '{"fields":{},"additions":[]}', finishReason: 'stop' })

    await generateSchemaEditJson('schema prompt', undefined, { ...generalTarget, jsonOutput: 'native' })

    expect(generateTextMock.mock.calls[0][0]).toMatchObject({
      output: expect.anything(),
      reasoning: 'none',
      messages: [{ role: 'user', content: 'schema prompt' }],
    })
  })

  it('rejects a length-truncated schema edit before parsing', async () => {
    generateTextMock.mockResolvedValue({ text: '{"fields":', finishReason: 'length' })

    await expect(generateSchemaEditJson('schema prompt', undefined, generalTarget)).rejects.toMatchObject({
      code: 'invalid_model_output',
    })
  })

  it('sanitizes model errors after the chat stream is committed', async () => {
    streamTextMock.mockReturnValue({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'error', error: new Error('upstream secret') })
          controller.close()
        },
      }),
    })
    const response = await streamChatWithModel([], '# Report', undefined, generalTarget)
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain('Chat failed.')
    expect(body).not.toContain('upstream secret')
  })
})

describe('renderNuExtractPrompt', () => {
  it.each(['content', 'markdown'] as const)('renders %s without a synthetic instructions slot', (mode) => {
    const rendered = renderNuExtractPrompt({
      mode,
      instructions: 'inline guidance',
      documentParts: [{ type: 'text', text: 'Source' }],
    })
    expect(rendered.prompt).toContain(`【task】${mode}`)
    expect(rendered.prompt).not.toContain('【instructions_start】')
    expect(rendered.prompt).toContain('<think>\n\n</think>')
  })
})
