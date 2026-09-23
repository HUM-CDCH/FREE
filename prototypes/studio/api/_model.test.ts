import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  generateSchemaEditJson,
  generateSchemaWithModel,
  streamChatWithModel,
} from './_model.js'
import type { ExecutionTarget } from './_provider.js'
import { DELETE as clearLlmInspector } from './llm_inspector.js'

const { generateTextMock, streamTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  streamTextMock: vi.fn(),
}))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: generateTextMock, streamText: streamTextMock }
})

const document = { file: null, markdown: 'Grave 1', pages: null }
const nuextractTarget: ExecutionTarget = {
  profile: 'nuextract',
  modelId: 'numind/NuExtract3-FP8',
  baseUrl: 'http://nuextract_model:8000/v1',
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

function stubNuExtractResponse(content: string, finishReason = 'stop') {
  const request = vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  )
  vi.stubGlobal('fetch', request)
  return request
}

afterEach(() => {
  vi.unstubAllGlobals()
  generateTextMock.mockReset()
  clearLlmInspector()
})

describe('generateSchemaWithModel', () => {
  it('repairs generated model JSON on the NuExtract path', async () => {
    stubNuExtractResponse('{"_description":"One grave record.","grave":[{"name":"verbatim-string"}}]')
    const result = await generateSchemaWithModel(
      { document, instruction: '' },
      nuextractTarget,
    )
    expect(result.template).toEqual({ _description: 'One grave record.', grave: [{ name: 'verbatim-string' }] })
  })

  it('rejects a generated schema without a root record description', async () => {
    stubNuExtractResponse('{"grave":[{"name":"verbatim-string"}]}')

    await expect(
      generateSchemaWithModel(
        { document, instruction: '' },
        nuextractTarget,
      ),
    ).rejects.toMatchObject({ code: 'invalid_model_output' })
  })

  it('asks vLLM for template generation, leading the message with schema guidance', async () => {
    const request = stubNuExtractResponse('{"_description":"One grave record.","grave":[{"name":"verbatim-string"}]}')
    await generateSchemaWithModel(
      { document, instruction: '' },
      nuextractTarget,
    )
    const [url, init] = request.mock.calls[0]!
    expect(url).toBe('http://nuextract_model:8000/v1/chat/completions')
    expect(init.headers).toMatchObject({ authorization: 'Bearer secret' })
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({
      model: 'numind/NuExtract3-FP8',
      chat_template_kwargs: { mode: 'template-generation', enable_thinking: false },
      temperature: 0.2,
    })
    expect(body.messages).toHaveLength(1)
    const text = JSON.stringify(body.messages[0].content)
    expect(text.indexOf('compact JSON extraction schema')).toBeLessThan(text.indexOf('Grave 1'))
    expect(text).not.toContain('【')
  })

  it('maps a failed NuExtract call to a model operation failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('overloaded', { status: 503 })))
    await expect(generateSchemaWithModel({ document, instruction: '' }, nuextractTarget))
      .rejects.toMatchObject({ status: 502, code: 'model_operation_failed' })
  })

  it('passes cancellation to the NuExtract request', async () => {
    const request = stubNuExtractResponse(
      '{"_description":"One grave record.","grave":[{"name":"verbatim-string"}]}',
    )
    const controller = new AbortController()

    await generateSchemaWithModel(
      { document, instruction: '', signal: controller.signal },
      nuextractTarget,
    )

    expect(request.mock.calls[0]?.[1]).toMatchObject({
      signal: controller.signal,
    })
  })

  it('uses the selected general target for schema suggestion', async () => {
    generateTextMock.mockResolvedValue({ text: '{"_description":"One grave record.","grave":[{"name":"verbatim-string"}]}' })
    const result = await generateSchemaWithModel(
      { document, instruction: '' },
      generalTarget,
    )
    expect(generateTextMock).toHaveBeenCalledOnce()
    expect(result.template).toEqual({ _description: 'One grave record.', grave: [{ name: 'verbatim-string' }] })
  })

  it('bounds schema context while retaining excerpts from every physical page', async () => {
    generateTextMock.mockResolvedValue({ text: '{"_description":"One entry.","label":"string"}' })
    const markdown = Array.from({ length: 45 }, (_, i) =>
      `<!-- FREE:PAGE ${i + 1} -->\nStart ${i + 1}\n${'Source '.repeat(1700)}\nEnd ${i + 1}\n`,
    ).join('\n')
    await generateSchemaWithModel({ document: { ...document, markdown }, instruction: '' }, generalTarget)
    const sent = JSON.stringify(generateTextMock.mock.calls[0][0].messages)
    expect(sent.length).toBeLessThan(55_000)
    for (let i = 1; i <= 45; i += 1) {
      expect(sent).toContain(`Start ${i}`)
      expect(sent).toContain(`End ${i}`)
    }
    expect(sent).toContain('excerpts')
  })

  it('passes cancellation to the generic model call', async () => {
    generateTextMock.mockResolvedValue({ text: '{"_description":"One grave record.","grave":[{"name":"verbatim-string"}]}' })
    const controller = new AbortController()

    await generateSchemaWithModel(
      { document, instruction: '', signal: controller.signal },
      generalTarget,
    )

    expect(generateTextMock.mock.calls[0]?.[0]).toMatchObject({
      abortSignal: controller.signal,
    })
  })
})

describe('interactive model operations', () => {
  it.each(['prompt', 'schema'] as const)('does not request schema-free JSON on a %s route', async (jsonOutput) => {
    generateTextMock.mockResolvedValue({ text: '{"fields":{},"additions":[]}', finishReason: 'stop' })

    const result = await generateSchemaEditJson('schema prompt', undefined, { ...generalTarget, jsonOutput })

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
