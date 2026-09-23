import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import parsedDocument from '../../../prototypes/studio/src/assets/parsed_document.v2.json' with { type: 'json' }
import type { ExtractionInputReader, ExtractionPersistence } from './dependencies.js'
import { ExtractionError } from './errors.js'
import type { ExtractionSnapshot } from './types.js'
import { keiExpAccepted, keiExpArtifact, keiExpCall, keiExpEnvelope, keiExpEvidence, keiExpGroundedArtifact } from './kei-exp-fixture.js'
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
  it('posts the pinned schema and maps artifact evidence, completeness, diagnostics and attribution', async () => {
    const h = harness([json(ack, 202), polled(artifact())])
    const result = await h.run()
    assert.equal(h.requests[0].url, `http://kei-exp:8001/api/runs/${encodeURIComponent(runId)}/extract`)
    // Never a single `model`: kei-exp routes each role to its deployment default unless the run chose otherwise.
    assert.deepEqual(JSON.parse(h.requests[0].init!.body as string), { schema, options: { strategy: 'article' } })
    assert.equal(h.requests[1].url, `http://kei-exp:8001/api/runs/${encodeURIComponent(runId)}/extractions/${ack.id}`)
    assert.deepEqual(result.result, { records: [{ title: 'Alpha', year: null }] })
    assert.deepEqual(result.evidence, [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'a_p1_s0', verbatim: true, lexicalHits: 1, linkedBy: 'lexical' }])
    assert.equal(result.complete, false)
    assert.equal(result.reviewable, true)
    assert.equal(result.outcome, 'SUCCEEDED')
    assert.deepEqual(result.modelAttribution, { provider: 'kei-exp', modelId: 'selected-model' })
    assert.deepEqual(result.diagnostics, { phase: 'persisting', durationMs: 1250, modelCalls: 3, inputTokens: 20, outputTokens: 10, finishReason: null, ungroundedPaths: [], groundingIssues: issues, groundingBatches: [], unverifiedFields: [], catalog: null, retry: null, models: { fields: 'selected-model', reasoning: 'selected-model' } })
  })

  it('sends a Catalog recipe and maps the version 2 artifact without dropping what review needs', async () => {
    const base = keiExpGroundedArtifact({ run_id: runId, model: 'selected-model', schema })
    // A glossary expansion travels beside the raw value, spans renamed to the client's casing.
    const glossary = { value: 'Heidekreis', rule: 'glossary' as const, key_span: { segment: 'p1_s0', start: 0, end: 5 },
                       expansion_span: { segment: 'p1_s0', start: 8, end: 18 } }
    const grounded = { ...base, evidence: base.evidence.map(link =>
      link.path[2] === 'kreis' ? { ...link, normalized: glossary } : link) }
    const h = harness([json(ack, 202), polled(grounded)], 'CATALOG', parsedDocument, 'numbered-catalogue-de@1')
    const result = await h.run()
    assert.deepEqual(JSON.parse(h.requests[0].init!.body as string).options,
      { strategy: 'catalog', catalog: { recipe: 'numbered-catalogue-de@1' } })
    assert.deepEqual(result.result, { records: grounded.records })
    assert.equal(result.complete, false)
    const sheet = result.evidence!.find((link) => link.resultPath[2] === 'mbl_old')!
    assert.equal(sheet.evidenceAnchorId, 'a_p1_s2')
    assert.deepEqual(sheet.grounding, {
      linkedBy: 'key', provenance: 'token', textSpans: [{ segment: 'p1_s2', start: 28, end: 32 }],
      keySpans: [{ segment: 'p1_s2', start: 23, end: 27 }], alternatives: [], heading: null, precision: 'segment',
      raw: '1827', normalized: null,
    })
    const kreis = result.evidence!.find((link) => link.resultPath[2] === 'kreis')!
    assert.equal(kreis.grounding!.provenance, 'inherited')
    assert.deepEqual(kreis.grounding!.normalized, { value: 'Heidekreis', rule: 'glossary',
      keySpan: { segment: 'p1_s0', start: 0, end: 5 }, expansionSpan: { segment: 'p1_s0', start: 8, end: 18 } })
    assert.equal(kreis.evidenceAnchorId, 'a_p1_s1')
    const report = result.diagnostics.grounded!
    assert.equal(report.recipe, 'numbered-catalogue-de@1')
    assert.deepEqual(report.completeness, grounded.completeness)
    assert.deepEqual(report.normalization, { version: 1, rules: ['glossary'] })
    assert.deepEqual(report.segmentationDiagnostics, grounded.segmentation.diagnostics)
    assert.deepEqual(report.coverage, grounded.coverage)
    assert.deepEqual(report.proposed, grounded.proposed)
    assert.deepEqual(report.rejected, grounded.rejected)
    assert.deepEqual(report.recordBlocks, grounded.record_blocks)
    assert.deepEqual(result.diagnostics.ungroundedPaths, [])
  })

  it('refuses a version 2 artifact produced under another recipe than the one requested', async () => {
    const other = keiExpGroundedArtifact({
      run_id: runId, model: 'selected-model', schema,
      segmentation: { ...keiExpGroundedArtifact().segmentation, recipe: { ...keiExpGroundedArtifact().segmentation.recipe, version: 2 } },
    })
    const h = harness([json(ack, 202), polled(other)], 'CATALOG', parsedDocument, 'numbered-catalogue-de@1')
    await assert.rejects(h.run(), (error: unknown) => error instanceof ExtractionError && error.code === 'invalid_model_output')
  })

  it('relays catalog, zero/multiple records, ungrounded paths and model-linked evidence', async () => {
    for (const records of [[], [{ title: 'A', year: 1901 }, { title: 'B', year: null }]]) {
      const value = artifact({ strategy: 'catalog', complete: true, records, evidence: [], ungrounded: records.length ? [['records', 0, 'title']] : [] })
      const h = harness([json(ack, 202), polled(value)], 'CATALOG')
      const result = await h.run()
      assert.equal(JSON.parse(h.requests[0].init!.body as string).options.strategy, 'catalog')
      assert.deepEqual(result.result, { records })
      assert.deepEqual(result.diagnostics.ungroundedPaths, value.ungrounded)
      assert.deepEqual(result.modelAttribution, { provider: 'kei-exp', modelId: 'selected-model' })
      assert.equal(result.complete, true)
    }
    const value = artifact({ evidence: [keiExpEvidence({ linked_by: 'model' })] })
    assert.equal((await harness([json(ack, 202), polled(value)]).run()).evidence![0].linkedBy, undefined)
  })

  it('counts model calls and tolerates a model server that reports no token usage', async () => {
    const value = artifact({ calls: [keiExpCall({ input_tokens: null, output_tokens: null, finish: null })], tokens: { input: null, output: null } })
    const result = await harness([json(ack, 202), polled(value)]).run()
    assert.equal(result.diagnostics.modelCalls, 1)
    assert.equal(result.diagnostics.inputTokens, null)
    assert.equal(result.diagnostics.outputTokens, null)
  })

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
    for (const value of [{}, artifact({ run_id: 'other' }), artifact({ generation: 'other' }), artifact({ strategy: 'catalog' }), artifact({ schema: { ...schema, recordDescription: 'Other schema' } })]) {
      await assert.rejects(harness([json(ack, 202), polled(value)]).run(), { code: 'invalid_model_output' })
    }
    await assert.rejects(harness([json(ack, 202), json({ nonsense: true })]).run(), { code: 'invalid_model_output' })
    await assert.rejects(harness([json({ ...ack, run_id: 'other' }, 202)]).run(), { code: 'invalid_model_output' })
    await assert.rejects(harness([new Response('not json')]).run(), { code: 'invalid_model_output' })
  })

  it('rejects results without model attribution before they can become unreadable saved results', async () => {
    for (const model of [null, '', undefined]) {
      await assert.rejects(
        harness([json(ack, 202), polled({ ...artifact(), model })]).run(),
        { code: 'invalid_model_output' },
      )
    }
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

  it('refuses an artifact produced under another Extraction Model Choice than the one requested', async () => {
    for (const recorded of [null, { fields: 'instruct' }, { fields: 'nuextract', reasoning: 'instruct' }]) {
      const value = artifact({ options: { strategy: 'article', model: null, models: recorded } })
      const h = harness([json(ack, 202), polled(value)], 'ARTICLE', parsedDocument, null, { fields: 'nuextract' })
      await assert.rejects(h.run(), { code: 'invalid_model_output' })
    }
    const unchosen = artifact({ options: { strategy: 'article', model: null, models: { fields: 'nuextract' } } })
    await assert.rejects(harness([json(ack, 202), polled(unchosen)]).run(), { code: 'invalid_model_output' })
  })

  it('rejects an artifact that does not name the model of each role', async () => {
    for (const models of [undefined, null, { fields: 'selected-model' }, { fields: '', reasoning: 'r' }])
      await assert.rejects(harness([json(ack, 202), polled({ ...artifact(), models })]).run(), { code: 'invalid_model_output' })
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

  it('relays the document-level field names kei-exp could not verify', async () => {
    const result = await harness([json(ack, 202), polled(artifact({ unverified: ['archive'] }))]).run()
    assert.deepEqual(result.diagnostics.unverifiedFields, ['archive'])
  })

  it('keeps batch identity and rejects unsupported targeted retries', async () => {
    const h = harness([json(ack, 202), polled(artifact())])
    const result = await h.execute({ ...h.input, kind: 'batch-member', batchExtractionId: 'batch' }, new AbortController().signal)
    assert.equal(result.batchExtractionId, 'batch')
    await assert.rejects(h.execute({ kind: 'retry', extractionId: 'retry', retryOfId: 'parent', retryDocument: false, rediscover: true, retryRecordStartBlockIds: [] }, new AbortController().signal), { code: 'invalid_retry' })
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
      unverifiedFields: ['archive'], catalog: null, retry: null,
    },
    result: { records: [{ title: 'Alpha', archive: 'Rigsarkivet' }] },
    evidence: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'bundled-anchor', verbatim: true, lexicalHits: 1, linkedBy: 'lexical' }],
    failure: null, reviewable: true, retryOfId: null, batchExtractionId: null,
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
