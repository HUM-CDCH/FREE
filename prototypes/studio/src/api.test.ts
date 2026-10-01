import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionController } from './useExtraction'
import {
  ApiRequestError,
  decodeSchemaDone,
  deleteModelOperation,
  finalizeExtractionReview,
  readExtraction,
  readIngestionModels,
  requestExtraction,
  requestSchema,
  requestSchemaEdit,
} from './api'
import { setModelKeyAccount } from './modelKeys/modelKeyHandoff'

// This file runs without a browser storage; the handoff reads this account's one stored key from here instead.
vi.mock('./modelKeys/modelKeyStore', () => ({
  storedModelKeys: () => ({
    '11111111-1111-4111-8111-111111111111': {
      provider: 'openai-compatible',
      baseUrl: 'https://a.example/v1',
      key: 'sk-test-api',
    },
  }),
}))

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
    runExtraction: async () => null,
    requestCancellation: async () => {},
    cancellationRequested: false,
    cancellationError: null,
    monitorError: null,
    reconnect: () => {},
    attempt: null,
    review: {
      available: false,
      canAccept: false,
      saving: false,
      loading: false,
      decisions: [],
      requiredCount: 0,
      untouchedCount: 0,
      isTouched: () => false,
      reviewedExtractionId: null,
      error: null,
      draftError: null,
      draftSaving: false,
      draftSaved: false,
      retryDraft: () => {},
      transfer: {},
      pairing: { pairings: [], sources: [], pair: () => {} },
      setDecision: () => {},
      undo: () => {},
      reload: () => {},
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
      catalogRecipe: null,
      executionStatus: 'COMPLETED',
      outcome: 'SUCCEEDED',
      complete: true,
      modelAttribution: { provider: 'ollama', modelId: 'fixture' },
      diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 0, finishReason: null, inputTokens: null, outputTokens: null, grounding: null, catalog: null },
      failure: null,
      resultPayload: { records: [] },
      evidenceLinks: [],
      reviewable: true,
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

    const method = { models: null, settings: { article: null } }
    await requestExtraction({
      id: extractionId,
      sourceRepresentationRevisionId: representationId,
      schemaRevisionId,
      strategy: 'ARTICLE',
      method,
    })
    await finalizeExtractionReview(extractionId, [])

    expect(submitted).toEqual([
      {
        url: '/api/extractions',
        body: { id: extractionId, sourceRepresentationRevisionId: representationId, schemaRevisionId, strategy: 'ARTICLE', method },
      },
      {
        url: `/api/extractions/${extractionId}/review`,
        body: { reviewDecisions: [], expectedDraftVersion: 0 },
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
        strategy: 'ARTICLE', catalogRecipe: null, executionStatus: 'COMPLETED', outcome: 'SUCCEEDED', complete: true,
        modelAttribution: { provider: 'ollama', modelId: 'fixture' },
        diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 0, finishReason: null, inputTokens: null, outputTokens: null, grounding: null, catalog: null },
        failure: null, resultPayload: { records: [] }, evidenceLinks: [],
        reviewable: true, batchExtractionId: null,
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
    }, undefined, { operationId: '51000000-0000-4000-8009-0000000000f1', base: null })

    expect(submittedUrl).toBe('/api/generate_schema')
    expect(Object.fromEntries(submittedBody!)).toEqual({
      project_context_id: '51000000-0000-4000-8000-000000000001',
      source_representation_revision_id:
        '51000000-0000-4000-8002-000000000001',
      operation_id: '51000000-0000-4000-8009-0000000000f1',
    })
  })

  it('requestSchema posts the operation ID and the base it starts from', async () => {
    const bodies: FormData[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      bodies.push(init.body as FormData)
      return Promise.resolve(jsonResponse({ template: {}, raw: '', pages: null }))
    }))
    const context = {
      projectContextId: '51000000-0000-4000-8000-000000000001',
      sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
    }

    await requestSchema(context, undefined, {
      instruction: 'Catalog entries',
      operationId: '51000000-0000-4000-8009-0000000000f1',
      base: { extractionSchemaId: '51000000-0000-4000-8003-000000000001', schemaRevisionId: '51000000-0000-4000-8004-000000000001' },
    })
    await requestSchema(context, undefined, { operationId: '51000000-0000-4000-8009-0000000000f2', base: null })

    expect(Object.fromEntries(bodies[0]!)).toEqual({
      project_context_id: context.projectContextId,
      source_representation_revision_id: context.sourceRepresentationRevisionId,
      instruction: 'Catalog entries',
      operation_id: '51000000-0000-4000-8009-0000000000f1',
      extraction_schema_id: '51000000-0000-4000-8003-000000000001',
      base_schema_revision_id: '51000000-0000-4000-8004-000000000001',
    })
    expect(Object.fromEntries(bodies[1]!)).toEqual({
      project_context_id: context.projectContextId,
      source_representation_revision_id: context.sourceRepresentationRevisionId,
      operation_id: '51000000-0000-4000-8009-0000000000f2',
    })
  })
})

describe('model work hands the keys over first', () => {
  afterEach(() => setModelKeyAccount(null))

  it('requestSchema and requestSchemaEdit hand the keys to Studio before their POST', async () => {
    setModelKeyAccount('10000000-0000-4000-8000-000000000001')
    const requests: string[] = []
    let failHandoff = false
    const fetch = vi.fn()
    vi.stubGlobal(
      'fetch',
      fetch.mockImplementation((url: string, init: RequestInit) => {
        requests.push(`${init.method} ${url}`)
        if (url === '/api/model-keys')
          return failHandoff
            ? Promise.reject(new TypeError('Failed to fetch'))
            : Promise.resolve(jsonResponse({ accepted: [] }))
        return Promise.resolve(
          url === '/api/generate_schema'
            ? jsonResponse({ template: {}, raw: '', pages: null })
            : jsonResponse({ status: 'proposed', fields: {}, additions: [], issues: [] }),
        )
      }),
    )
    const context = {
      projectContextId: '51000000-0000-4000-8000-000000000001',
      sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
    }
    const schemaContext = {
      ...context,
      extractionSchemaId: '51000000-0000-4000-8003-000000000001',
      schemaRevisionId: '51000000-0000-4000-8004-000000000001',
    }

    // The POST waits for the handoff's answer.
    const handoff = Promise.withResolvers<Response>()
    fetch.mockImplementationOnce((url: string, init: RequestInit) => {
      requests.push(`${init.method} ${url}`)
      return handoff.promise
    })
    const schema = requestSchema(context, undefined, { operationId: '51000000-0000-4000-8009-0000000000f1', base: null })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests).toEqual(['PUT /api/model-keys'])
    handoff.resolve(jsonResponse({ accepted: [] }))
    await schema

    await requestSchemaEdit(schemaContext, 'Add title', undefined, '51000000-0000-4000-8009-0000000000f3')
    expect(requests).toEqual([
      'PUT /api/model-keys',
      'POST /api/generate_schema',
      'PUT /api/model-keys',
      'POST /api/edit_schema',
    ])

    // A handoff that fails still lets the model work start; Studio then waits for the key or answers model_key_required.
    failHandoff = true
    requests.length = 0
    await requestSchema(context, undefined, { operationId: '51000000-0000-4000-8009-0000000000f1', base: null })
    await requestSchemaEdit(schemaContext, 'Add title', undefined, '51000000-0000-4000-8009-0000000000f3')
    expect(requests).toEqual([
      'PUT /api/model-keys',
      'POST /api/generate_schema',
      'PUT /api/model-keys',
      'POST /api/edit_schema',
    ])
  })
})

describe('repeatable model POST', () => {
  const ACCOUNT = '10000000-0000-4000-8000-000000000001'
  const context = {
    projectContextId: '51000000-0000-4000-8000-000000000001',
    sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
  }
  const OPERATION = '51000000-0000-4000-8009-0000000000f1'
  type Answer = () => Response | Promise<Response>
  const errorResponse = (status: number, code: string) =>
    new Response(JSON.stringify({ error: { code, message: 'Copy.' } }), { status, headers: { 'content-type': 'application/json' } })

  /** A fetch that hands the keys over on every PUT and answers each POST from `answers` in turn (the last one repeats). */
  function stubFetch(answers: Answer[]) {
    const requests: string[] = []
    const bodies: FormData[] = []
    let posts = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init: RequestInit) => {
      requests.push(`${init.method} ${url}`)
      if (url === '/api/model-keys') return Promise.resolve(jsonResponse({ accepted: [] }))
      bodies.push(init.body as FormData)
      const answer = answers[Math.min(posts, answers.length - 1)]!
      posts += 1
      return Promise.resolve().then(answer)
    }))
    return { requests, bodies, posts: () => posts }
  }

  beforeEach(() => {
    setModelKeyAccount(ACCOUNT)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    setModelKeyAccount(null)
  })

  it('a model POST is repeated with the same body after a network failure or a proxy 502/503/504, keys first each time', async () => {
    const stub = stubFetch([
      () => { throw new TypeError('Failed to fetch') },
      () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
      () => jsonResponse({ template: { title: 'string' }, raw: '', pages: null }),
    ])

    const result = requestSchema(context, undefined, { instruction: 'Catalog entries', operationId: OPERATION, base: null })
    await vi.advanceTimersByTimeAsync(3_000)

    await expect(result).resolves.toEqual({ title: 'string' })
    expect(stub.requests).toEqual([
      'PUT /api/model-keys', 'POST /api/generate_schema',
      'PUT /api/model-keys', 'POST /api/generate_schema',
      'PUT /api/model-keys', 'POST /api/generate_schema',
    ])
    const sent = stub.bodies.map((body) => Object.fromEntries(body))
    expect(sent).toHaveLength(3)
    for (const body of sent)
      expect(body).toEqual({
        project_context_id: context.projectContextId,
        source_representation_revision_id: context.sourceRepresentationRevisionId,
        instruction: 'Catalog entries',
        operation_id: OPERATION,
      })
  })

  it('a confirmed failure is never repeated; an uncertain one at most three times', async () => {
    const run = async (answers: Answer[]) => {
      const stub = stubFetch(answers)
      const result = requestSchema(context, undefined, { operationId: OPERATION, base: null })
      const outcome = result.then(() => 'resolved', (error: Error) => error.message)
      await vi.advanceTimersByTimeAsync(10_000)
      return { outcome: await outcome, posts: stub.posts() }
    }
    expect(await run([() => errorResponse(409, 'model_key_required')])).toEqual({ outcome: 'model_key_required: Copy.', posts: 1 })
    expect(await run([() => errorResponse(502, 'model_operation_failed')])).toEqual({ outcome: 'model_operation_failed: Copy.', posts: 1 })
    expect(await run([() => errorResponse(503, 'persistence_unavailable')])).toEqual({ outcome: 'persistence_unavailable: Copy.', posts: 4 })
    expect(await run([() => errorResponse(504, 'operation_pending')])).toEqual({ outcome: 'operation_pending: Copy.', posts: 4 })
  })

  it('an abort ends the repetition', async () => {
    const stub = stubFetch([() => { throw new TypeError('Failed to fetch') }])
    const controller = new AbortController()

    const result = requestSchema(context, controller.signal, { operationId: OPERATION, base: null })
    const outcome = result.then(() => 'resolved', (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(stub.posts()).toBe(1)
    controller.abort()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(stub.posts()).toBe(1)
  })

  it('a network failure while reading a 200 body is repeated under the same ID; malformed JSON is not', async () => {
    const stub = stubFetch([
      () => new Response(new ReadableStream({ start: (controller) => controller.error(new TypeError('network error')) }), { status: 200, headers: { 'content-type': 'application/json' } }),
      () => jsonResponse({ template: { title: 'string' }, raw: '', pages: null }),
    ])
    const result = requestSchema(context, undefined, { operationId: OPERATION, base: null })
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(result).resolves.toEqual({ title: 'string' })
    expect(stub.posts()).toBe(2)
    expect(stub.bodies.map((body) => Object.fromEntries(body).operation_id)).toEqual([OPERATION, OPERATION])

    const malformed = stubFetch([() => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })])
    const outcome = requestSchema(context, undefined, { operationId: OPERATION, base: null }).then(() => 'resolved', (error: Error) => error.name)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await outcome).toBe('SyntaxError')
    expect(malformed.posts()).toBe(1)
  })

  it('an abort during the key handoff ends the wait without a POST', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init: RequestInit) => {
      requests.push(`${init.method} ${url}`)
      return new Promise<Response>(() => {}) // the handoff's PUT never answers
    }))
    const controller = new AbortController()
    const outcome = requestSchema(context, controller.signal, { operationId: OPERATION, base: null }).then(() => 'resolved', (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(requests).toEqual(['PUT /api/model-keys'])

    controller.abort()
    await vi.advanceTimersByTimeAsync(0)

    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(requests).toEqual(['PUT /api/model-keys'])
  })

  it('deleteModelOperation encodes the workflow ID', async () => {
    const requests: string[] = []
    const statuses = [204, 404, 503]
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init: RequestInit) => {
      requests.push(`${init.method} ${url}`)
      const status = statuses.shift()!
      return Promise.resolve(status === 503 ? errorResponse(503, 'persistence_unavailable') : new Response(null, { status }))
    }))
    const workflowId = 'suggestion:51000000-0000-4000-8009-0000000000f1'

    await expect(deleteModelOperation(workflowId)).resolves.toBeUndefined()
    await expect(deleteModelOperation(workflowId)).resolves.toBeUndefined()
    await expect(deleteModelOperation(workflowId)).rejects.toMatchObject({ name: 'ApiRequestError', status: 503, message: 'persistence_unavailable: Copy.' })
    expect(requests).toEqual(Array(3).fill('DELETE /api/model-operations/suggestion%3A51000000-0000-4000-8009-0000000000f1'))
  })
})

describe('readIngestionModels', () => {
  const listing = {
    defaults: { ocr: 'surya', layout: 'layout_heron_101' },
    models: {
      ocr: [{ key: 'surya', label: 'datalab-to/surya-ocr-2', serving: false }],
      layout: [{ key: 'layout_heron_101', label: 'Heron-101', serving: true }],
    },
  }

  it('reads kei\'s listing through Studio with the caller\'s signal and refuses a drifted one', async () => {
    const controller = new AbortController()
    const requests: Array<{ url: string; init: RequestInit }> = []
    let body: unknown = listing
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init: RequestInit) => {
        requests.push({ url, init })
        return Promise.resolve(jsonResponse(body))
      }),
    )

    await expect(readIngestionModels(controller.signal)).resolves.toEqual(listing)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/api/ingestion-models')
    expect(requests[0].init.method).toBe('GET')
    expect(requests[0].init.credentials).toBe('same-origin')
    expect(requests[0].init.signal).toBe(controller.signal)

    body = { ...listing, defaults: { ocr: 'surya' } }
    await expect(readIngestionModels()).rejects.toThrow()
  })

  it('surfaces a 503 as a request error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ error: { code: 'ingestion_models_unavailable', message: 'The Parsing Service could not list its ingestion models.' } }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      )),
    )
    const failure = readIngestionModels()
    await expect(failure).rejects.toBeInstanceOf(ApiRequestError)
    await expect(failure).rejects.toMatchObject({
      status: 503,
      message: 'ingestion_models_unavailable: The Parsing Service could not list its ingestion models.',
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
      undefined,
      '51000000-0000-4000-8009-0000000000f3',
    )

    expect(Object.fromEntries(submittedBody!)).toEqual({
      project_context_id: '51000000-0000-4000-8000-000000000001',
      source_representation_revision_id:
        '51000000-0000-4000-8002-000000000001',
      extraction_schema_id: '51000000-0000-4000-8003-000000000001',
      schema_revision_id: '51000000-0000-4000-8004-000000000001',
      instruction: 'Add title',
      operation_id: '51000000-0000-4000-8009-0000000000f3',
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
        runExtractionStrategy: { strategy: 'ARTICLE' },
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
