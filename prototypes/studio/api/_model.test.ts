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
      grave: [{ name: { value: 'Grave 1', snippet: 'Grave 1', page: 1, row_header: null, column_header: null, source_scope: { segment_id: 'article:0', markdown_start: 0, markdown_end: 7, start_page: 1, end_page: 1 } } }],
    })
  })

  it('warns but keeps valid JSON with fields outside the extraction schema', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubOllamaResponse('{"grave":[{"name":"Grave 1","extra":"invented"}]}')

    const result = await extractWithModel({
      document,
      template: { grave: [{ name: 'verbatim-string' }] },
    })

    expect(result.result).toEqual({
      grave: [{ name: 'Grave 1', extra: 'invented' }],
    })
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

  it('adds row_header/column_header slots and instruction when hasTables is true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          response:
            '{"grave":[{"name":{"value":"Grave 1","snippet":"Grave 1","page":1,"row_header":"Row 1","column_header":"Name"}}]}',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await extractWithModel({
      document,
      template: { grave: [{ name: 'verbatim-string' }] },
      hasTables: true,
    })

    const body = fetchMock.mock.calls[0][1].body as string
    expect(body).toContain('row_header')
    expect(body).toContain('column_header')
    expect(result.evidence).toEqual({
      grave: [
        { name: { value: 'Grave 1', snippet: 'Grave 1', page: 1, row_header: 'Row 1', column_header: 'Name', source_scope: { segment_id: 'article:0', markdown_start: 0, markdown_end: 7, start_page: 1, end_page: 1 } } },
      ],
    })
  })

  it('omits row_header/column_header slots and instruction when hasTables is false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ response: '{"grave":[{"name":{"value":"Grave 1","snippet":"Grave 1","page":1}}]}' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await extractWithModel({
      document,
      template: { grave: [{ name: 'verbatim-string' }] },
    })

    const body = fetchMock.mock.calls[0][1].body as string
    expect(body).not.toContain('row_header')
    expect(body).not.toContain('column_header')
  })

  it('sections markdown by its recurring heading pattern and extracts each section independently', async () => {
    const markdown = '# Grave 1\n\nDepth: 10\n\n---\n\n# Grave 2\n\nDepth: 20\n'
    const fetchMock = vi.fn().mockImplementation(async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { prompt: string }
      const response = body.prompt.includes('Grave 1')
        ? '{"name":{"value":"Grave 1","snippet":"Grave 1","page":1}}'
        : '{"name":{"value":"Grave 2","snippet":"Grave 2","page":1}}'
      return new Response(JSON.stringify({ response }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await extractWithModel({
      document: { file: null, markdown, pages: null },
      template: { _strategy: 'catalog', entries: [{ name: 'verbatim-string' }] },
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.result).toEqual({ entries: [{ name: 'Grave 1' }, { name: 'Grave 2' }] })
    // Each section only sees its own text, so the model's "page" is
    // section-relative (1); extractWithModel must remap it to the section's
    // true absolute page (1 and 2, split by the "---" page break).
    expect(result.evidence).toEqual({
      entries: [
        { name: { value: 'Grave 1', snippet: 'Grave 1', page: 1, row_header: null, column_header: null, source_scope: { segment_id: 'catalog:0', markdown_start: 0, markdown_end: 25, start_page: 1, end_page: 1 } } },
        { name: { value: 'Grave 2', snippet: 'Grave 2', page: 2, row_header: null, column_header: null, source_scope: { segment_id: 'catalog:1', markdown_start: 27, markdown_end: 47, start_page: 2, end_page: 2 } } },
      ],
    })
  })

  it('detects tables per section, not from a whole-document flag: only the section with a table gets row_header/column_header', async () => {
    const markdown =
      '# Grave 1\n\n' +
      '| Nummer | Beskrivelse |\n| --- | --- |\n| 8-1 | Kæbe og tænder |\n\n' +
      '# Grave 2\n\n' +
      'A plain narrative section with no table at all.\n'
    const fetchMock = vi.fn().mockImplementation(async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { prompt: string }
      if (body.prompt.includes('Kæbe')) {
        // The table section's request must ask for row_header/column_header...
        expect(body.prompt).toContain('row_header')
        expect(body.prompt).toContain('column_header')
        return new Response(
          JSON.stringify({
            response:
              '{"name":{"value":"8-1","snippet":"8-1","page":1,"row_header":"8-1","column_header":"Nummer"}}',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      // ...but the plain-narrative section's request must not.
      expect(body.prompt).not.toContain('row_header')
      expect(body.prompt).not.toContain('column_header')
      return new Response(
        JSON.stringify({ response: '{"name":{"value":"Grave 2","snippet":"Grave 2","page":1}}' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await extractWithModel({
      document: { file: null, markdown, pages: null },
      template: { _strategy: 'catalog', entries: [{ name: 'verbatim-string' }] },
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.evidence).toEqual({
      entries: [
        { name: { value: '8-1', snippet: '8-1', page: 1, row_header: '8-1', column_header: 'Nummer', source_scope: { segment_id: 'catalog:0', markdown_start: 0, markdown_end: 74, start_page: 1, end_page: 1 } } },
        { name: { value: 'Grave 2', snippet: 'Grave 2', page: 1, row_header: null, column_header: null, source_scope: { segment_id: 'catalog:1', markdown_start: 76, markdown_end: 134, start_page: 1, end_page: 1 } } },
      ],
    })
  })

  it('drops a sectioned entry whose extraction came back entirely empty', async () => {
    const markdown = '# Grave 1\n\nDepth: 10\n\n# Grave 2\n\nNothing relevant here.\n'
    const fetchMock = vi.fn().mockImplementation(async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { prompt: string }
      const response = body.prompt.includes('Depth: 10')
        ? '{"name":{"value":"Grave 1","snippet":"Grave 1","page":1}}'
        : '{"name":{"value":"","snippet":null,"page":null}}'
      return new Response(JSON.stringify({ response }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await extractWithModel({
      document: { file: null, markdown, pages: null },
      template: { _strategy: 'catalog', entries: [{ name: 'verbatim-string' }] },
    })

    expect(result.result).toEqual({ entries: [{ name: 'Grave 1' }] })
    expect(result.evidence).toMatchObject({
      entries: [{ name: { source_scope: { segment_id: 'catalog:0', markdown_start: 0, start_page: 1 } } }],
    })
  })

  it('falls back to a single whole-document call when the markdown has no recurring heading pattern', async () => {
    stubOllamaResponse('{"entries":[{"name":{"value":"Grave 1","snippet":"Grave 1","page":1}}]}')

    await extractWithModel({
      document: { file: null, markdown: 'No headings at all here.', pages: null },
      template: { _strategy: 'catalog', entries: [{ name: 'verbatim-string' }] },
    })

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('falls back to a single whole-document call when the template mixes a sibling field alongside the array', async () => {
    stubOllamaResponse(
      '{"site_name":{"value":"Ellekilde","snippet":"Ellekilde","page":1},"entries":[{"name":{"value":"Grave 1","snippet":"Grave 1","page":1}}]}',
    )
    const markdown = '# Grave 1\n\nDepth: 10\n\n# Grave 2\n\nDepth: 20\n'

    await extractWithModel({
      document: { file: null, markdown, pages: null },
      template: { _strategy: 'catalog', site_name: 'string', entries: [{ name: 'verbatim-string' }] },
    })

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('never sections when _strategy is "article", even if the schema and heading pattern would otherwise qualify', async () => {
    stubOllamaResponse(
      '{"entries":[{"name":{"value":"Grave 1","snippet":"Grave 1","page":1}},{"name":{"value":"Grave 2","snippet":"Grave 2","page":1}}]}',
    )
    const markdown = '# Grave 1\n\nDepth: 10\n\n# Grave 2\n\nDepth: 20\n'

    await extractWithModel({
      document: { file: null, markdown, pages: null },
      template: { _strategy: 'article', entries: [{ name: 'verbatim-string' }] },
    })

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('never sections when _strategy is unset, even if the schema and heading pattern would otherwise qualify', async () => {
    stubOllamaResponse(
      '{"entries":[{"name":{"value":"Grave 1","snippet":"Grave 1","page":1}},{"name":{"value":"Grave 2","snippet":"Grave 2","page":1}}]}',
    )
    const markdown = '# Grave 1\n\nDepth: 10\n\n# Grave 2\n\nDepth: 20\n'

    await extractWithModel({
      document: { file: null, markdown, pages: null },
      template: { entries: [{ name: 'verbatim-string' }] },
    })

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('routes codex-cli extraction through the AI SDK instead of Ollama', async () => {
    vi.stubEnv('AI_PROVIDER', 'codex-cli')
    vi.stubEnv('AI_MODEL', 'gpt-5.6-terra')
    const fetchMock = vi.fn().mockRejectedValue(new Error('Ollama must not be called'))
    vi.stubGlobal('fetch', fetchMock)
    generateTextMock.mockResolvedValue({
      text: '{"grave":[{"name":{"value":"Grave 1","snippet":"Grave 1","page":1}}]}',
    })

    const result = await extractWithModel({
      document,
      template: { grave: [{ name: 'verbatim-string' }] },
    })

    expect(fetchMock).not.toHaveBeenCalled()
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

    await generateSchemaWithModel({
      document,
      annotations: [],
      annotationsMode: 'hints',
    })

    const body = fetchMock.mock.calls[0][1].body as string
    expect(body.indexOf('compact JSON extraction schema')).toBeLessThan(body.indexOf('Grave 1'))
  })

  it('withholds the rest of the document in fields mode, sending only the annotations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ response: '{"grave":[{"name":"verbatim-string"}]}' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await generateSchemaWithModel({
      document: { file: null, markdown: 'Grave 1\n\nUnrelated content elsewhere in the report.', pages: null },
      annotations: [{ text: 'Grave 1', pageNumber: 1 }],
      annotationsMode: 'fields',
    })

    const body = fetchMock.mock.calls[0][1].body as string
    expect(body).toContain('Grave 1')
    expect(body).not.toContain('Unrelated content elsewhere in the report.')
  })

  it('routes codex-cli schema suggestions through the AI SDK', async () => {
    vi.stubEnv('AI_PROVIDER', 'codex-cli')
    vi.stubEnv('AI_MODEL', 'gpt-5.6-terra')
    const fetchMock = vi.fn().mockRejectedValue(new Error('Ollama must not be called'))
    vi.stubGlobal('fetch', fetchMock)
    generateTextMock.mockResolvedValue({
      text: '{"grave":[{"name":"verbatim-string"}]}',
    })

    const result = await generateSchemaWithModel({
      document,
      annotations: [],
      annotationsMode: 'hints',
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(generateTextMock).toHaveBeenCalledOnce()
    expect(result.template).toEqual({ grave: [{ name: 'verbatim-string' }] })
  })
})
