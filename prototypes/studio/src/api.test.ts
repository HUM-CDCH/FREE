import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionController } from './useExtraction'
import {
  decodeExtractDone,
  decodeSchemaDone,
  fetchParsedDocument,
  parseDocument,
  requestExtraction,
  requestGrounding,
  requestSchema,
} from './api'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => vi.unstubAllGlobals())

function minimalParsedDocument() {
  return {
    schema_version: 'parsed_document.v2',
    document: {
      document_id: 'document-a', content_sha256: 'a'.repeat(64),
      source: { kind: 'upload', original_filename: 'source.pdf', media_type: 'application/pdf', byte_size: null },
      created_at: 'now', page_count: 1, language_hints: [], is_encrypted: false,
      input_profile: { file_kind: 'pdf', detected_mime: 'application/pdf', pdf_version: null, has_text_layer: true, has_images: false },
    },
    preprocessing: { preprocess_id: 'test', profile: 'production_default', service_version: null, started_at: null, finished_at: null, status: 'completed', warnings: [] },
    page_count: 1, page_mapping_verified: true,
    artifacts: { source_ref: 'source.pdf', parsed_json_ref: 'parsed_document.json', markdown_ref: 'artifacts/document.llm.md' },
    parser_runs: [], arbitration: null, diagnostics: [],
    pages: [{ page_number: 1, width_pt: 100, height_pt: 100, rotation: 0, ordered_content: [], unplaced_content: [], markdown_span: null }],
    content_stream: [], tables: [], evidence_index: { anchors: [] },
  }
}

function readyController(): ExtractionController {
  return {
    state: {
      status: 'ready',
      result: { title: 'Report' },
      evidenceLinks: [],
      groundingIssues: [],
    },
    canRun: true,
    hasResults: true,
    runExtraction: async () => {},
    retryGrounding: async () => {},
    review: {
      available: false,
      canAccept: false,
      saving: false,
      reviewedExtractionId: null,
      error: null,
      accept: async () => {},
    },
  }
}

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
        new Response(JSON.stringify({ error: { code: 'model_operation_failed', message: 'Model endpoint error.' } }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )

    await expect(requestExtraction(new Blob(['pdf']), 'report.pdf', {})).rejects.toThrow(
      'model_operation_failed: Model endpoint error.',
    )
  })
})

describe('requestGrounding', () => {
  it('posts the grounding protocol to the buffered provider-neutral route', async () => {
    let submittedUrl = ''
    const submittedForms: FormData[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init: RequestInit) => {
        submittedUrl = url
        if (init.body instanceof FormData) submittedForms.push(init.body)
        return Promise.resolve(
          jsonResponse({
            result: { links: { C1: 'E2' } },
            reasoning: null,
            raw: '{"links":{"C1":"E2"}}',
            pages: null,
            modelAttribution: { provider: 'fixture', modelId: 'grounder' },
          }),
        )
      }),
    )

    const done = await requestGrounding({
      documentMarkdown: '[E2] Ellekilde',
      template: { links: { C1: 'verbatim-string' } },
      instruction: '[C1] $.site = "Ellekilde"',
    })
    const form = submittedForms[0]

    expect(submittedUrl).toBe('/api/extract')
    expect(form.get('document_markdown')).toBe('[E2] Ellekilde')
    expect(form.get('template')).toBe(
      '{"links":{"C1":"verbatim-string"}}',
    )
    expect(form.get('instruction')).toBe(
      '[C1] $.site = "Ellekilde"',
    )
    expect(form.has('file')).toBe(false)
    expect(done).toEqual({
      result: { links: { C1: 'E2' } },
      modelAttribution: { provider: 'fixture', modelId: 'grounder' },
    })
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

describe('fetchParsedDocument', () => {
  it('decodes the strict v2 document route', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(minimalParsedDocument())))
    const document = await fetchParsedDocument('task-1')
    expect(document.page_count).toBe(1)
  })

  it('rejects alternate or unknown document fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      schema_version: 'parsed_document.v2', future_field: 'not allowed',
    })))
    await expect(fetchParsedDocument('task-1')).rejects.toThrow()
  })
})

describe('parseDocument', () => {
  it('starts a job, polls until completed, and returns the markdown and document', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/tasks')) {
          return Promise.resolve(jsonResponse({ task_id: 'abc', status: 'pending' }))
        }
        if (url.endsWith('/tasks/abc')) {
          return Promise.resolve(jsonResponse({ status: 'completed' }))
        }
        if (url.endsWith('/tasks/abc/markdown')) {
          return Promise.resolve(new Response('# Doc', { status: 200 }))
        }
        if (url.endsWith('/tasks/abc/document')) {
          return Promise.resolve(jsonResponse(minimalParsedDocument()))
        }
        return Promise.reject(new Error(`unexpected ${url}`))
      }),
    )

    const parsed = await parseDocument(new Blob(['pdf']), 'report.pdf')
    expect(parsed.markdown).toBe('# Doc')
    expect(parsed.document.page_count).toBe(1)
  })

  it('throws the job error when parsing fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/tasks')) {
          return Promise.resolve(jsonResponse({ task_id: 'abc' }))
        }
        if (url.endsWith('/tasks/abc')) {
          return Promise.resolve(jsonResponse({ status: 'failed', error: 'boom' }))
        }
        return Promise.reject(new Error(`unexpected ${url}`))
      }),
    )

    await expect(parseDocument(new Blob(['pdf']), 'report.pdf')).rejects.toThrow('boom')
  })
})

describe('decoders', () => {
  it('fail loud when response contracts drift', () => {
    expect(() => decodeExtractDone({ raw: '{}' })).toThrow("extract: response missing 'result'")
    expect(decodeExtractDone({ result: {}, raw: '{}' }).result).toEqual({})
    expect(() => decodeSchemaDone({ raw: '{}' })).toThrow("generate_schema: response missing 'template'")
  })
})

describe('ResultsTab markdown', () => {
  it('receives parsed document markdown directly', async () => {
    vi.resetModules()
    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof import('react')>('react')
      return {
        ...actual,
        useState: (initialState: unknown) =>
          initialState === 'review' ? ['markdown', () => undefined] : actual.useState(initialState),
      }
    })
    const { default: ResultsTab } = await import('./ResultsTab')
    const html = renderToStaticMarkup(
      createElement(ResultsTab, {
        controller: readyController(),
        schemaReady: true,
        documentMarkdown: '# Parsed source',
      }),
    )

    vi.doUnmock('react')
    expect(html).toContain('Markdown')
    expect(html).toContain('# Parsed source')
  })
})
