import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  editSchemaWithModel,
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
vi.mock('./_model_config.js', () => ({
  readModelConfig: vi.fn(),
}))
vi.mock('./_provider.js', () => ({
  appendProviderResource: (baseUrl: string, resource: string) =>
    `${baseUrl.replace(/\/+$/, '')}/${resource.replace(/^\/+/, '')}`,
  resolveCapabilityRoute: vi.fn(),
}))

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
  streamTextMock.mockReset()
  clearLlmInspector()
})

describe('extractWithModel', () => {
  it('preserves raw NuExtract transport fields and mirrored evidence', async () => {
    const request = stubOllamaResponse(
      '{"grave":[{"name":"Grave 1","_evidence":{"name":{"snippet":"Grave 1","page":1}}}]}',
    )
    const result = await extractWithModel(
      { document, template: { grave: [{ name: 'verbatim-string' }] } },
      rawTarget,
    )

    expect(result.result).toEqual({ grave: [{ name: 'Grave 1' }] })
    expect(result.evidence).toEqual({
      grave: [
        {
          name: {
            value: 'Grave 1',
            snippet: 'Grave 1',
            page: 1,
            row_header: null,
            column_header: null,
            source_scope: {
              segment_id: 'article:0',
              markdown_start: 0,
              markdown_end: 7,
              start_page: 1,
              end_page: 1,
            },
          },
        },
      ],
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
      options: { temperature: 0.2, num_ctx: 131072 },
    })
    expect(body).not.toHaveProperty('chat_template_kwargs')
    expect(body.prompt).toContain('"name": "verbatim-string"')
    expect(body.prompt).toContain('"_evidence"')
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

  it('preserves a path-prefixed Ollama server base for raw generation', async () => {
    const request = stubOllamaResponse(
      '{"grave":[{"name":"Grave 1","_evidence":{"name":{"snippet":"Grave 1","page":1}}}]}',
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

  it('adds row_header/column_header slots and instruction when hasTables is true', async () => {
    const request = stubOllamaResponse(
      '{"grave":[{"name":"Grave 1","_evidence":{"name":{"snippet":"Grave 1","page":1,"row_header":"Row 1","column_header":"Name"}}}]}',
    )

    const result = await extractWithModel(
      { document, template: { grave: [{ name: 'verbatim-string' }] }, hasTables: true },
      rawTarget,
    )

    const body = request.mock.calls[0][1].body as string
    expect(body).toContain('row_header')
    expect(body).toContain('column_header')
    expect(result.evidence).toEqual({
      grave: [
        {
          name: {
            value: 'Grave 1',
            snippet: 'Grave 1',
            page: 1,
            row_header: 'Row 1',
            column_header: 'Name',
            source_scope: { segment_id: 'article:0', markdown_start: 0, markdown_end: 7, start_page: 1, end_page: 1 },
          },
        },
      ],
    })
  })

  it('omits row_header/column_header slots and instruction when hasTables is false', async () => {
    const request = stubOllamaResponse(
      '{"grave":[{"name":"Grave 1","_evidence":{"name":{"snippet":"Grave 1","page":1}}}]}',
    )

    await extractWithModel(
      { document, template: { grave: [{ name: 'verbatim-string' }] } },
      rawTarget,
    )

    const body = request.mock.calls[0][1].body as string
    expect(body).not.toContain('row_header')
    expect(body).not.toContain('column_header')
  })

  it('sections markdown by its recurring heading pattern and extracts each section independently', async () => {
    const markdown = '# Grave 1\n\nDepth: 10\n\n---\n\n# Grave 2\n\nDepth: 20\n'
    const request = vi.fn().mockImplementation(async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { prompt: string }
      const response = body.prompt.includes('Grave 1')
        ? '{"name":"Grave 1","_evidence":{"name":{"snippet":"Grave 1","page":1}}}'
        : '{"name":"Grave 2","_evidence":{"name":{"snippet":"Grave 2","page":1}}}'
      return new Response(JSON.stringify({ response }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', request)

    const result = await extractWithModel(
      {
        document: { file: null, markdown, pages: null },
        template: { _strategy: 'catalog', entries: [{ name: 'verbatim-string' }] },
      },
      rawTarget,
    )

    expect(request).toHaveBeenCalledTimes(2)
    expect(result.result).toEqual({ entries: [{ name: 'Grave 1' }, { name: 'Grave 2' }] })
    expect(result.evidence).toEqual({
      entries: [
        {
          name: {
            value: 'Grave 1',
            snippet: 'Grave 1',
            page: 1,
            row_header: null,
            column_header: null,
            source_scope: { segment_id: 'catalog:0', markdown_start: 0, markdown_end: 25, start_page: 1, end_page: 1 },
          },
        },
        {
          name: {
            value: 'Grave 2',
            snippet: 'Grave 2',
            page: 2,
            row_header: null,
            column_header: null,
            source_scope: { segment_id: 'catalog:1', markdown_start: 27, markdown_end: 47, start_page: 2, end_page: 2 },
          },
        },
      ],
    })
  })

  it('detects tables per section, not from a whole-document flag', async () => {
    const markdown =
      '# Grave 1\n\n' +
      '| Nummer | Beskrivelse |\n| --- | --- |\n| 8-1 | Kaebe og taender |\n\n' +
      '# Grave 2\n\n' +
      'A plain narrative section with no table at all.\n'
    const request = vi.fn().mockImplementation(async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { prompt: string }
      if (body.prompt.includes('Kaebe')) {
        expect(body.prompt).toContain('row_header')
        expect(body.prompt).toContain('column_header')
        return new Response(
          JSON.stringify({
            response:
              '{"name":"8-1","_evidence":{"name":{"snippet":"8-1","page":1,"row_header":"8-1","column_header":"Nummer"}}}',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      expect(body.prompt).not.toContain('row_header')
      expect(body.prompt).not.toContain('column_header')
      return new Response(
        JSON.stringify({ response: '{"name":"Grave 2","_evidence":{"name":{"snippet":"Grave 2","page":1}}}' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', request)

    const result = await extractWithModel(
      {
        document: { file: null, markdown, pages: null },
        template: { _strategy: 'catalog', entries: [{ name: 'verbatim-string' }] },
      },
      rawTarget,
    )

    expect(request).toHaveBeenCalledTimes(2)
    expect(result.evidence).toEqual({
      entries: [
        {
          name: {
            value: '8-1',
            snippet: '8-1',
            page: 1,
            row_header: '8-1',
            column_header: 'Nummer',
            source_scope: { segment_id: 'catalog:0', markdown_start: 0, markdown_end: 76, start_page: 1, end_page: 1 },
          },
        },
        {
          name: {
            value: 'Grave 2',
            snippet: 'Grave 2',
            page: 1,
            row_header: null,
            column_header: null,
            source_scope: { segment_id: 'catalog:1', markdown_start: 78, markdown_end: 136, start_page: 1, end_page: 1 },
          },
        },
      ],
    })
  })

  it('drops a sectioned entry whose extraction came back entirely empty', async () => {
    const markdown = '# Grave 1\n\nDepth: 10\n\n# Grave 2\n\nNothing relevant here.\n'
    const request = vi.fn().mockImplementation(async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { prompt: string }
      const response = body.prompt.includes('Depth: 10')
        ? '{"name":"Grave 1","_evidence":{"name":{"snippet":"Grave 1","page":1}}}'
        : '{"name":"","_evidence":{"name":{"snippet":null,"page":null}}}'
      return new Response(JSON.stringify({ response }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', request)

    const result = await extractWithModel(
      {
        document: { file: null, markdown, pages: null },
        template: { _strategy: 'catalog', entries: [{ name: 'verbatim-string' }] },
      },
      rawTarget,
    )

    expect(result.result).toEqual({ entries: [{ name: 'Grave 1' }] })
    expect(result.evidence).toMatchObject({
      entries: [{ name: { source_scope: { segment_id: 'catalog:0', markdown_start: 0, start_page: 1 } } }],
    })
  })

  it('falls back to a single whole-document call when the markdown has no recurring heading pattern', async () => {
    const request = stubOllamaResponse(
      '{"entries":[{"name":"Grave 1","_evidence":{"name":{"snippet":"Grave 1","page":1}}}]}',
    )

    await extractWithModel(
      {
        document: { file: null, markdown: 'No headings at all here.', pages: null },
        template: { _strategy: 'catalog', entries: [{ name: 'verbatim-string' }] },
      },
      rawTarget,
    )

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('falls back to a single whole-document call when the template mixes a sibling field alongside the array', async () => {
    const request = stubOllamaResponse(
      '{"site_name":"Ellekilde","entries":[{"name":"Grave 1","_evidence":{"name":{"snippet":"Grave 1","page":1}}}]}',
    )
    const markdown = '# Grave 1\n\nDepth: 10\n\n# Grave 2\n\nDepth: 20\n'

    await extractWithModel(
      {
        document: { file: null, markdown, pages: null },
        template: { _strategy: 'catalog', site_name: 'string', entries: [{ name: 'verbatim-string' }] },
      },
      rawTarget,
    )

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('never sections when _strategy is "article"', async () => {
    const request = stubOllamaResponse(
      '{"entries":[{"name":"Grave 1","_evidence":{"name":{"snippet":"Grave 1","page":1}}},{"name":"Grave 2","_evidence":{"name":{"snippet":"Grave 2","page":1}}}]}',
    )
    const markdown = '# Grave 1\n\nDepth: 10\n\n# Grave 2\n\nDepth: 20\n'

    await extractWithModel(
      {
        document: { file: null, markdown, pages: null },
        template: { _strategy: 'article', entries: [{ name: 'verbatim-string' }] },
      },
      rawTarget,
    )

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('never sections when _strategy is unset', async () => {
    const request = stubOllamaResponse(
      '{"entries":[{"name":"Grave 1","_evidence":{"name":{"snippet":"Grave 1","page":1}}},{"name":"Grave 2","_evidence":{"name":{"snippet":"Grave 2","page":1}}}]}',
    )
    const markdown = '# Grave 1\n\nDepth: 10\n\n# Grave 2\n\nDepth: 20\n'

    await extractWithModel(
      {
        document: { file: null, markdown, pages: null },
        template: { entries: [{ name: 'verbatim-string' }] },
      },
      rawTarget,
    )

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('uses direct general execution without calling Ollama', async () => {
    const request = vi.fn().mockRejectedValue(new Error('raw transport must not run'))
    vi.stubGlobal('fetch', request)
    generateTextMock.mockResolvedValue({
      text: '{"grave":[{"name":"Grave 1","_evidence":{"name":{"snippet":"Grave 1","page":1}}}]}',
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

  it('withholds the rest of the document in fields mode, sending only the annotations', async () => {
    const request = stubOllamaResponse('{"grave":[{"name":"verbatim-string"}]}')

    await generateSchemaWithModel(
      {
        document: { file: null, markdown: 'Grave 1\n\nUnrelated content elsewhere in the report.', pages: null },
        annotations: [{ text: 'Grave 1', pageNumber: 1 }],
        annotationsMode: 'fields',
      },
      rawTarget,
    )

    const body = request.mock.calls[0][1].body as string
    expect(body).toContain('Grave 1')
    expect(body).not.toContain('Unrelated content elsewhere in the report.')
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
