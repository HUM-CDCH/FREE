import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import parsedDocument from '../../../prototypes/studio/src/assets/parsed_document.v2.json' with { type: 'json' }
import type { ExtractionInputReader, ExtractionPersistence } from './dependencies.js'
import { ExtractionError } from './errors.js'
import type { ExtractionSnapshot } from './types.js'
import { keiExpAccepted, keiExpArtifact, keiExpCall, keiExpEnvelope, keiExpEvidence } from './kei-exp-fixture.js'
import { createKeiExpClient, retryAfterMs, type KeiExpArtifact, type KeiExpStatus } from './kei-exp.js'
import { createExtractionJobExecutor, createExtractionModule } from './module.js'

const schema = {
  recordDescription: 'Article records.',
  schemaNodes: [{ id: 'title', name: 'title', type: 'string' as const }, { id: 'year', name: 'year', type: 'integer' as const }],
}
const runId = parsedDocument.document.document_id
const ack = keiExpAccepted({ run_id: runId })
const issues = [{ code: 'missing_value', detail: 'No year', record: 0, path: ['records', 0, 'year'] }]
function artifact(overrides: Partial<KeiExpArtifact> = {}): KeiExpArtifact {
  return keiExpArtifact({
    run_id: runId, strategy: 'article', model: 'selected-model', schema,
    options: { strategy: 'article', model: 'selected-model', discovery_chars: 48_000, record_chars: 24_000 },
    records: [{ title: 'Alpha', year: null }],
    evidence: [keiExpEvidence()],
    issues,
    calls: [keiExpCall({ stage: 'document', record: null }), keiExpCall({ stage: 'record' }), keiExpCall({ stage: 'grounding' })],
    tokens: { input: 20, output: 10 },
    ...overrides,
  })
}
function harness(responses: Array<Response | Error>, strategy: 'ARTICLE' | 'CATALOG' = 'ARTICLE', document = parsedDocument,
  catalogRecipe: string | null = null, models: Readonly<{ fields?: string; reasoning?: string }> | null = null) {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const inputs: ExtractionInputReader = {
    readExtractionAttempt: async () => null,
    loadExtractionInputs: async (sourceRepresentationRevisionId, schemaRevisionId) => ({
      sourceDocumentId: 'source', projectContextId: 'project', sourceRepresentationRevisionId, schemaRevisionId,
      schemaTree: schema, parsedDocument: document,
    }),
  }
  const keiExp = createKeiExpClient({
    url: 'http://kei-exp:8001/', pollIntervalMs: 1,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init })
      const next = responses.shift()
      assert.ok(next, 'unexpected extra request')
      if (next instanceof Error) throw next
      return next
    },
  })
  const execute = createExtractionJobExecutor({ inputs, keiExp })
  const input = { kind: 'fresh' as const, extractionId: randomUUID(), sourceRepresentationRevisionId: randomUUID(), schemaRevisionId: randomUUID(), strategy, catalogRecipe, models }
  return {
    requests, input, execute,
    run: (signal = new AbortController().signal) => execute(input, signal),
  }
}
const json = (body: unknown, status = 200, headers?: Record<string, string>) => Response.json(body, { status, headers })
/** The polling envelope kei-exp really serves: the artifact is nested under `result`. */
const polled = (result: unknown, status: KeiExpStatus = 'done', overrides: Record<string, unknown> = {}) =>
  json(keiExpEnvelope({ id: ack.id as string, run_id: runId, status, result: status === 'done' ? result : null, ...overrides }))

describe('kei-exp extraction relay', () => {
  it('waits through queued/running, 429 and 503 on both endpoints and network errors while polling', async () => {
    const h = harness([
      json({}, 503), json({}, 429), json(ack, 202),
      polled(null, 'queued'), polled(null, 'running'), json({}, 429),
      new TypeError('network'), json({}, 503), polled(artifact()),
    ])
    await h.run()
    assert.equal(h.requests.length, 9)
    assert.equal(h.requests.filter(r => r.init?.method === 'POST').length, 3)
  })

  it('never reposts after a lost response, because kei-exp mints the extraction id', async () => {
    for (const error of [new TypeError('fetch failed'), new DOMException('the request timed out', 'TimeoutError')]) {
      const h = harness([error])
      await assert.rejects(h.run(), (rejection: unknown) =>
        rejection instanceof ExtractionError && rejection.code === 'extraction_failed' && rejection.message.includes(error.message))
      assert.equal(h.requests.length, 1)
    }
  })

  it('waits for Retry-After rather than the poll interval when kei-exp sends one', async () => {
    const h = harness([json({ detail: 'the queue is full' }, 429, { 'retry-after': '60' }), json(ack, 202), polled(artifact())])
    await assert.rejects(h.run(AbortSignal.timeout(30)), (error: unknown) =>
      error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    assert.equal(h.requests.length, 1)
  })

  it('reads Retry-After as delta-seconds or an HTTP date, and falls back when it is unusable', () => {
    assert.equal(retryAfterMs(null, 1500), 1500)
    assert.equal(retryAfterMs('2', 1500), 2000)
    assert.equal(retryAfterMs(' 3 ', 1500), 3000)
    assert.equal(retryAfterMs('', 1500), 1500)
    assert.equal(retryAfterMs('soon', 1500), 1500)
    assert.equal(retryAfterMs('-5', 1500), 1500)
    assert.equal(retryAfterMs('86400', 1500), 60_000)
    assert.ok(Math.abs(retryAfterMs(new Date(Date.now() + 4_000).toUTCString(), 1500) - 4_000) <= 1_500)
  })

  it('names the reason kei-exp gave for a nonretryable HTTP response', async () => {
    const cases: Array<[number, Response, string]> = [
      [409, json({ detail: 'the run has no complete result to extract from: result.json is missing' }, 409), 'result.json is missing'],
      [404, json({ detail: 'the run is not in the store: a historical file-only run cannot be extracted' }, 404), 'file-only run cannot be extracted'],
      [422, json({ detail: [{ loc: ['body', 'schema'], msg: 'Extra inputs are not permitted' }] }, 422), 'Extra inputs are not permitted'],
      [500, new Response('Internal Server Error', { status: 500 }), 'Internal Server Error'],
    ]
    for (const [status, response, expected] of cases) {
      await assert.rejects(harness([response]).run(), (error: unknown) =>
        error instanceof ExtractionError && error.code === 'extraction_failed' &&
        error.message.includes(String(status)) && error.message.includes(expected))
    }
  })

  it('fails on nonretryable HTTP responses and malformed or mismatched artifacts', async () => {
    for (const status of [404, 409, 400, 500]) {
      const h = harness([json({}, status)])
      await assert.rejects(h.run(), { code: 'extraction_failed' })
      assert.equal(h.requests.length, 1)
    }
    // The artifact is checked against the request by acceptKeiArtifact (kei-artifact.test.ts); the client checks only
    // what it alone saw: the envelope, and the generation its acknowledgement named.
    for (const value of [{}, artifact({ generation: 'other' })])
      await assert.rejects(harness([json(ack, 202), polled(value)]).run(), { code: 'invalid_model_output' })
    await assert.rejects(harness([json(ack, 202), json({ nonsense: true })]).run(), { code: 'invalid_model_output' })
    await assert.rejects(harness([json({ ...ack, run_id: 'other' }, 202)]).run(), { code: 'invalid_model_output' })
    await assert.rejects(harness([new Response('not json')]).run(), { code: 'invalid_model_output' })
  })

  it('fails with kei-exp\'s reason when the extraction failed, and distinctly when it was cancelled', async () => {
    await assert.rejects(
      harness([json(ack, 202), polled(null, 'failed', { error: 'the model server refused the request' })]).run(),
      (error: unknown) => error instanceof ExtractionError && error.code === 'extraction_failed' &&
        error.message.includes('the model server refused the request'),
    )
    await assert.rejects(harness([json(ack, 202), polled(null, 'failed', { error: null })]).run(), { code: 'extraction_failed' })
    await assert.rejects(harness([json(ack, 202), polled(null, 'cancelled')]).run(), { code: 'cancelled' })
  })

  it('cancels polling and does not POST when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = harness([])
    await assert.rejects(h.run(controller.signal), { name: 'AbortError' })
    assert.equal(h.requests.length, 0)
    const polling = harness([json(ack, 202), polled(null, 'running')])
    await assert.rejects(polling.run(AbortSignal.timeout(2)), error => error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
  })

  it('retries an interrupted response body and bounds transient failures by the catalog deadline', async (t) => {
    const broken = new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('connection reset')) } }))
    await harness([json(ack, 202), broken, polled(artifact())]).run()
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    const deadlines: number[] = []
    t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      deadlines.push(milliseconds)
      return timeout(milliseconds === 3 * 60 * 60 * 1000 ? 10 : milliseconds)
    })
    let calls = 0
    const client = createKeiExpClient({
      url: 'http://kei-exp:8001', pollIntervalMs: 1,
      fetch: async () => { calls += 1; return json({}, 503) },
    })
    await assert.rejects(client.extract({ runId, schema, strategy: 'catalog', expectedGeneration: null, signal: new AbortController().signal }),
      error => error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    assert.equal(deadlines[0], 3 * 60 * 60 * 1000)
    assert.ok(calls >= 1)
  })

  it('refuses a generation other than the pinned one on the acknowledgement, before the work is done', async () => {
    const document = structuredClone(parsedDocument)
    document.preprocessing.profile = 'kei-exp'
    document.preprocessing.preprocess_id = `kei-exp:${runId}:g1`
    for (const anchor of document.evidence_index.anchors) anchor.preprocess_id = document.preprocessing.preprocess_id
    const h = harness([json({ ...ack, generation: 'g2' }, 202)], 'ARTICLE', document)
    await assert.rejects(h.run(), { code: 'invalid_source_representation' })
    assert.equal(h.requests.length, 1, 'the mismatch must be caught before the first poll')
    await harness([json(ack, 202), polled(artifact())], 'ARTICLE', document).run()
    const unreadable = structuredClone(document)
    unreadable.preprocessing.preprocess_id = 'kei-exp:other-run:g1'
    await assert.rejects(harness([], 'ARTICLE', unreadable).run(), { code: 'invalid_source_representation' })
  })

  it('omits options.models when the run chose no role, leaving kei-exp its deployment defaults', async () => {
    for (const models of [undefined, null, {}, { fields: undefined }]) {
      const bodies: string[] = []
      const client = createKeiExpClient({
        url: 'http://kei-exp:8001', pollIntervalMs: 1,
        fetch: async (_url, init) => {
          bodies.push(String(init?.body ?? ''))
          return bodies.length === 1 ? json(ack, 202) : polled(artifact())
        },
      })
      await client.extract({ runId, schema, strategy: 'article', models, expectedGeneration: null, signal: new AbortController().signal })
      assert.deepEqual(JSON.parse(bodies[0]), { schema, options: { strategy: 'article' } })
    }
  })

  it('sends the Extraction Model Choice as options.models and records the model each role ran on', async () => {
    const models = { fields: 'selected-model', reasoning: 'reasoning-model' }
    const value = artifact({ models, options: { strategy: 'article', model: null, models: { reasoning: 'instruct' } } })
    const h = harness([json(ack, 202), polled(value)], 'ARTICLE', parsedDocument, null, { reasoning: 'instruct' })
    const result = await h.run()
    assert.deepEqual(JSON.parse(h.requests[0].init!.body as string).options, { strategy: 'article', models: { reasoning: 'instruct' } })
    // Attribution stays the model that read the values: the fields model.
    assert.deepEqual(result.modelAttribution, { provider: 'kei-exp', modelId: 'selected-model' })
    assert.deepEqual(result.diagnostics.models, models)
  })

  it('sends batch-member model choices and preserves deployment defaults when unchosen', async () => {
    for (const models of [null, { fields: 'nuextract', reasoning: 'instruct' }, { reasoning: 'instruct' }]) {
      const value = artifact({ options: { strategy: 'article', model: null, models } })
      const h = harness([json(ack, 202), polled(value)])
      const result = await h.execute({
        ...h.input, kind: 'batch-member', batchExtractionId: 'batch', models,
      }, new AbortController().signal)
      assert.equal(result.batchExtractionId, 'batch')
      assert.deepEqual(JSON.parse(h.requests[0].init!.body as string).options,
        { strategy: 'article', ...(models ? { models } : {}) })
    }
  })

  it('lists the deployment\'s extraction models, their roles and the default per role', async () => {
    const listing = {
      defaults: { fields: 'nuextract', reasoning: 'instruct' },
      models: [
        { key: 'instruct', repo: 'Qwen/Qwen3.8-27B-FP8', roles: ['fields', 'reasoning'], reachable: true, serving: true },
        { key: 'nuextract', repo: 'numind/NuExtract3-FP8', roles: ['fields'], reachable: true, serving: false },
      ],
    }
    const requests: string[] = []
    const client = (response: Response | Error) => createKeiExpClient({
      url: 'http://kei-exp:8001/', pollIntervalMs: 1,
      fetch: async (url, init) => {
        requests.push(`${init?.method ?? 'GET'} ${String(url)}`)
        if (response instanceof Error) throw response
        return response
      },
    })
    assert.deepEqual(await client(json(listing)).listModels(new AbortController().signal), listing)
    assert.deepEqual(requests, ['GET http://kei-exp:8001/api/extraction-models'])
    await assert.rejects(client(json({ detail: 'the store is down' }, 503)).listModels(), (error: unknown) =>
      error instanceof ExtractionError && error.code === 'model_unavailable' && error.message.includes('the store is down'))
    await assert.rejects(client(new TypeError('fetch failed')).listModels(), (error: unknown) =>
      error instanceof ExtractionError && error.code === 'model_unavailable' && error.message.includes('fetch failed'))
    for (const invalid of [json({ models: [] }), json({ ...listing, models: [{ key: 'x' }] }), new Response('not json')])
      await assert.rejects(client(invalid).listModels(), { code: 'invalid_model_output' })
  })

  it('listIngestionModels reads kei\'s listing and refuses an invalid one', async () => {
    const listing = {
      defaults: { ocr: 'surya', layout: 'layout_heron_101' },
      models: {
        ocr: [
          { key: 'surya', label: 'datalab-to/surya-ocr-2', serving: true },
          { key: 'granite_docling', label: 'ibm-granite/granite-docling-258M', serving: false },
        ],
        layout: [{ key: 'layout_heron_101', label: 'Heron-101', serving: true }],
      },
    }
    const requests: string[] = []
    const client = (response: Response | Error) => createKeiExpClient({
      url: 'http://kei-exp:8001/', pollIntervalMs: 1,
      fetch: async (url, init) => {
        requests.push(`${init?.method ?? 'GET'} ${String(url)}`)
        if (response instanceof Error) throw response
        return response
      },
    })
    assert.deepEqual(await client(json(listing)).listIngestionModels(new AbortController().signal), listing)
    assert.deepEqual(requests, ['GET http://kei-exp:8001/api/ingestion-models'])
    await assert.rejects(client(json({ detail: 'the OCR server is down' }, 503)).listIngestionModels(), (error: unknown) =>
      error instanceof ExtractionError && error.code === 'model_unavailable' && error.message.includes('the OCR server is down'))
    await assert.rejects(client(new TypeError('fetch failed')).listIngestionModels(), (error: unknown) =>
      error instanceof ExtractionError && error.code === 'model_unavailable'
      && error.message.includes('kei-exp could not be reached to list its ingestion models') && error.message.includes('fetch failed'))
    const { defaults: _, ...withoutDefaults } = listing
    for (const invalid of [json(withoutDefaults), json({ ...listing, models: { ...listing.models, ocr: [{ key: 'surya' }] } }), new Response('not json')])
      await assert.rejects(client(invalid).listIngestionModels(), { code: 'invalid_model_output' })
    await assert.rejects(client(json(withoutDefaults)).listIngestionModels(), { message: 'kei-exp returned an invalid ingestion model listing.' })
  })

})

describe('review of an Extraction with document-level schema fields', () => {
  // kei-exp copies a `valueSource: document` field into every record, never grounds it and never
  // lists it under `ungrounded` — it names it under `unverified` instead. The coverage invariant
  // therefore accounts for document fields the way it already accounts for source-filename ones.
  const reviewSchema = {
    recordDescription: 'Catalogue records.',
    schemaNodes: [
      { id: 'title', name: 'title', type: 'string' as const },
      { id: 'archive', name: 'archive', type: 'string' as const, valueSource: 'document' as const },
    ],
  }
  const extractionId = randomUUID()
  const decision = {
    resultPath: ['records', 0, 'title'], evidenceAnchorId: 'bundled-anchor',
    reviewedOccurrenceIds: ['bundled-occurrence'], action: 'APPROVED' as const, reviewedValue: null,
  }
  const extraction: ExtractionSnapshot = {
    extractionId, sourceDocumentId: randomUUID(), sourceRepresentationRevisionId: randomUUID(),
    sourceRepresentationRevisionNumber: 1, schemaRevisionId: randomUUID(),
    extractionSchemaId: randomUUID(), schemaRevisionNumber: 1, strategy: 'ARTICLE',
    outcome: 'SUCCEEDED', complete: true, modelAttribution: { provider: 'kei-exp', modelId: 'm' },
    diagnostics: {
      phase: 'persisting', durationMs: 1, modelCalls: 1, finishReason: null, inputTokens: null,
      outputTokens: null, ungroundedPaths: [], groundingIssues: [], groundingBatches: [],
      unverifiedFields: ['archive'], catalog: null,
    },
    result: { records: [{ title: 'Alpha', archive: 'Rigsarkivet' }] },
    evidence: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'bundled-anchor', verbatim: true, lexicalHits: 1, linkedBy: 'lexical' }],
    failure: null, reviewable: true, batchExtractionId: null,
    createdAt: new Date(), reviewedAt: null, reviewDecisions: [],
  }
  const persistence = {
    readExtraction: async () => extraction,
    readCanonicalParsedDocument: async () => parsedDocument,
    loadExtractionInputs: async () => ({
      sourceDocumentId: extraction.sourceDocumentId, projectContextId: 'project',
      sourceRepresentationRevisionId: extraction.sourceRepresentationRevisionId,
      schemaRevisionId: extraction.schemaRevisionId, schemaTree: reviewSchema, parsedDocument,
    }),
    finalizeReview: async () => ({ status: 'reviewed' as const, extraction }),
  } as unknown as ExtractionPersistence

  it('finalizes a review whose only unaccounted value is the unverified document field', async () => {
    const module = createExtractionModule(persistence)
    const finalized = await module.finalizeReview(extractionId, [decision])
    assert.equal(finalized.disposition, 'reviewed')
  })
})


