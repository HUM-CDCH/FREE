import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionController } from './useExtraction'
import {
  decodeSchemaDone,
  fetchParsedDocument,
  finalizeExtractionReview,
  parseDocument,
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
      ungroundedCount: 0,
    },
    canRun: true,
    hasResults: true,
    runExtraction: async () => {},
    requestCancellation: async () => {},
    cancellationRequested: false,
    cancellationError: null,
    attempt: null,
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

describe('Article extraction lifecycle client', () => {
  it('posts only the operation identity and finalizes review by Extraction ID', async () => {
    const extractionId = '11111111-1111-4111-8111-111111111111'
    const representationId = '22222222-2222-4222-8222-222222222222'
    const schemaRevisionId = '33333333-3333-4333-8333-333333333333'
    const documentId = '44444444-4444-4444-8444-444444444444'
    const attempt = {
      extractionId,
      sourceDocumentId: documentId,
      sourceRepresentationRevisionId: representationId,
      schemaRevisionId,
      strategy: 'ARTICLE',
      outcome: 'SUCCEEDED',
      complete: true,
      modelAttribution: { provider: 'ollama', modelId: 'fixture' },
      diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 0, finishReason: null, inputTokens: null, outputTokens: null, values: null, grounding: null },
      failure: null,
      resultPayload: { records: [] },
      evidenceLinks: [],
      reviewable: true,
      retryOfId: null,
      createdAt: '2026-08-10T00:00:00.000Z',
      reviewedAt: null,
      reviewDecisions: [],
    }
    const submitted: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init: RequestInit) => {
        submitted.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
        return Promise.resolve(jsonResponse(attempt))
      }),
    )

    await requestExtraction({
      id: extractionId,
      sourceRepresentationRevisionId: representationId,
      schemaRevisionId,
      strategy: 'ARTICLE',
    })
    await finalizeExtractionReview(extractionId, [])

    expect(submitted).toEqual([
      {
        url: '/api/extractions',
        body: { id: extractionId, sourceRepresentationRevisionId: representationId, schemaRevisionId, strategy: 'ARTICLE' },
      },
      {
        url: `/api/extractions/${extractionId}/review`,
        body: { reviewDecisions: [] },
      },
    ])
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
