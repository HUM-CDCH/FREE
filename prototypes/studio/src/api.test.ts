import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionController } from './useExtraction'
import {
  decodeSchemaDone,
  finalizeExtractionReview,
  readExtraction,
  requestExtraction,
  requestSchema,
  requestSchemaEdit,
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
    stale: false,
    runExtraction: async () => {},
    retryExtraction: async () => null,
    requestCancellation: async () => {},
    cancellationRequested: false,
    cancellationError: null,
    attempt: null,
    review: {
      available: false,
      canAccept: false,
      saving: false,
      loading: false,
      decisions: [],
      reviewedCount: 0,
      untouchedCount: 0,
      isTouched: () => false,
      reviewedExtractionId: null,
      error: null,
      setDecision: () => {},
      approveAll: () => {},
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
      executionStatus: 'COMPLETED',
      outcome: 'SUCCEEDED',
      complete: true,
      modelAttribution: { provider: 'ollama', modelId: 'fixture' },
      diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 0, finishReason: null, inputTokens: null, outputTokens: null, grounding: null, catalog: null, retry: null },
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
        expect(init.credentials).toBe('same-origin')
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

  it('reads server-derived pending review decisions', async () => {
    const extractionId = '11111111-1111-4111-8111-111111111111'
    const response = {
      extraction: {
        extractionId,
        sourceDocumentId: '44444444-4444-4444-8444-444444444444',
        sourceRepresentationRevisionId: '22222222-2222-4222-8222-222222222222',
        schemaRevisionId: '33333333-3333-4333-8333-333333333333',
        strategy: 'ARTICLE', executionStatus: 'COMPLETED', outcome: 'SUCCEEDED', complete: true,
        modelAttribution: { provider: 'ollama', modelId: 'fixture' },
        diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 0, finishReason: null, inputTokens: null, outputTokens: null, grounding: null, catalog: null, retry: null },
        failure: null, resultPayload: { records: [] }, evidenceLinks: [],
        reviewable: true, retryOfId: null, batchExtractionId: null,
        createdAt: '2026-08-10T00:00:00.000Z', reviewedAt: null, reviewDecisions: [],
      },
      pendingReviewDecisions: [],
    }
    const fetch = vi.fn().mockResolvedValue(jsonResponse(response))
    vi.stubGlobal('fetch', fetch)

    await expect(readExtraction(extractionId)).resolves.toEqual(response)
    expect(fetch).toHaveBeenCalledWith(
      `/api/extractions/${extractionId}`,
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })
})

describe('requestSchema', () => {
  it('submits only the owner-scoped source identity', async () => {
    let submittedUrl = ''
    let submittedBody: FormData | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init: RequestInit) => {
        expect(init.credentials).toBe('same-origin')
        submittedUrl = url
        submittedBody = init.body as FormData
        return Promise.resolve(
          jsonResponse({ template: {}, raw: '', pages: null }),
        )
      }),
    )

    await requestSchema({
      projectContextId: '51000000-0000-4000-8000-000000000001',
      sourceRepresentationRevisionId:
        '51000000-0000-4000-8002-000000000001',
    })

    expect(submittedUrl).toBe('/api/generate_schema')
    expect(Object.fromEntries(submittedBody!)).toEqual({
      project_context_id: '51000000-0000-4000-8000-000000000001',
      source_representation_revision_id:
        '51000000-0000-4000-8002-000000000001',
    })
  })
})

describe('requestSchemaEdit', () => {
  it('submits durable schema pins without browser-authored schema or source data', async () => {
    let submittedBody: FormData | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        expect(init.credentials).toBe('same-origin')
        submittedBody = init.body as FormData
        return Promise.resolve(
          jsonResponse({
            status: 'proposed',
            fields: {},
            additions: [],
            issues: [],
          }),
        )
      }),
    )

    await requestSchemaEdit(
      {
        projectContextId: '51000000-0000-4000-8000-000000000001',
        sourceRepresentationRevisionId:
          '51000000-0000-4000-8002-000000000001',
        extractionSchemaId: '51000000-0000-4000-8003-000000000001',
        schemaRevisionId: '51000000-0000-4000-8004-000000000001',
      },
      'Add title',
    )

    expect(Object.fromEntries(submittedBody!)).toEqual({
      project_context_id: '51000000-0000-4000-8000-000000000001',
      source_representation_revision_id:
        '51000000-0000-4000-8002-000000000001',
      extraction_schema_id: '51000000-0000-4000-8003-000000000001',
      schema_revision_id: '51000000-0000-4000-8004-000000000001',
      instruction: 'Add title',
    })
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
        onRunExtraction: async () => undefined,
        runExtractionDisabled: false,
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
