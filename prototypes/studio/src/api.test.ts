import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionController } from './useExtraction'
import {
  decodeSchemaDone,
  finalizeExtractionReview,
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
    retryExtraction: async () => {},
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
      batchExtractionId: null,
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
        body: { id: extractionId, sourceRepresentationRevisionId: representationId, schemaRevisionId, strategy: 'ARTICLE', batchExtractionId: null },
      },
      {
        url: `/api/extractions/${extractionId}/review`,
        body: { reviewDecisions: [] },
      },
    ])
  })

  it('posts a strict targeted Catalog retry without caller pins or strategy', async () => {
    const parentId = '11111111-1111-4111-8111-111111111111'
    const childId = '55555555-5555-4555-8555-555555555555'
    const submitted: unknown[] = []
    const attempt = {
      extractionId: childId,
      sourceDocumentId: '44444444-4444-4444-8444-444444444444',
      sourceRepresentationRevisionId: '22222222-2222-4222-8222-222222222222',
      schemaRevisionId: '33333333-3333-4333-8333-333333333333',
      strategy: 'CATALOG',
      outcome: 'SUCCEEDED',
      complete: true,
      modelAttribution: { provider: 'ollama', modelId: 'fixture' },
      diagnostics: {
        phase: 'grounding', durationMs: 1, modelCalls: 0,
        finishReason: null, inputTokens: null, outputTokens: null,
        values: null, grounding: null, catalog: { stages: [], records: [] },
      },
      failure: null, resultPayload: { records: [] }, evidenceLinks: [],
      reviewable: true, retryOfId: parentId, batchExtractionId: null,
      createdAt: '2026-08-10T00:00:00.000Z', reviewedAt: null, reviewDecisions: [],
    }
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      submitted.push(JSON.parse(String(init.body)))
      return Promise.resolve(jsonResponse(attempt))
    }))

    await requestExtraction({
      id: childId,
      retryOfId: parentId,
      retryDocument: true,
      rediscover: false,
      retryRecordStartBlockIds: ['heading-2'],
    })

    expect(submitted).toEqual([{
      id: childId,
      retryOfId: parentId,
      retryDocument: true,
      rediscover: false,
      retryRecordStartBlockIds: ['heading-2'],
    }])
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
        sourceDocumentName: 'source.pdf',
      }),
    )

    vi.doUnmock('react')
    expect(html).toContain('Markdown')
    expect(html).toContain('# Parsed source')
  })
})
