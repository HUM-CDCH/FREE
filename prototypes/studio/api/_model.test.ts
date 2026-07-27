import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  editSchemaWithModel,
  extractWithModel,
  generateSchemaWithModel,
  renderNuExtractPrompt,
  streamChatWithModel,
} from './_model.js'
import type { ExecutionTarget } from './_provider.js'

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
  model: {} as never,
  jsonOutput: 'prompt',
  temperatureSupported: false,
}

function stubOllamaResponse(response: string) {
  const request = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ response }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', request)
  return request
}

afterEach(() => {
  vi.unstubAllGlobals()
  generateTextMock.mockReset()
})

describe('extractWithModel', () => {
  it('preserves raw NuExtract transport fields and mirrored evidence', async () => {
    const request = stubOllamaResponse(
      '{"grave":[{"name":{"value":"Grave 1","snippet":"Grave 1","page":1}}]}',
    )
    const result = await extractWithModel(
      { document, template: { grave: [{ name: 'verbatim-string' }] } },
      rawTarget,
    )

    expect(result.result).toEqual({ grave: [{ name: 'Grave 1' }] })
    expect(result.evidence).toEqual({
      grave: [{ name: { value: 'Grave 1', snippet: 'Grave 1', page: 1 } }],
    })
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
  })

  it('preserves a path-prefixed Ollama server base for raw generation', async () => {
    const request = stubOllamaResponse(
      '{"grave":[{"name":{"value":"Grave 1","snippet":"Grave 1","page":1}}]}',
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
      text: '{"grave":[{"name":{"value":"Grave 1","snippet":"Grave 1","page":1}}]}',
    })
    const result = await extractWithModel(
      { document, template: { grave: [{ name: 'verbatim-string' }] } },
      generalTarget,
    )
    expect(request).not.toHaveBeenCalled()
    expect(generateTextMock.mock.calls[0][0]).not.toHaveProperty('temperature')
    expect(result.result).toEqual({ grave: [{ name: 'Grave 1' }] })
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
  it('adds Source Markdown to schema editing only when supplied', async () => {
    generateTextMock.mockResolvedValue({ text: '[]' })
    await editSchemaWithModel({}, 'No changes', null, undefined, generalTarget)
    expect(generateTextMock.mock.calls[0][0].messages[0].content).not.toContain('Source Document Markdown:')

    await editSchemaWithModel({}, 'No changes', '# Report', undefined, generalTarget)
    expect(generateTextMock.mock.calls[1][0].messages[0].content).toContain('Source Document Markdown:\n# Report')
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
