import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import parsedDocument from '../../../prototypes/studio/src/assets/parsed_document.v2.json' with { type: 'json' }
import type { ExtractionInputReader } from './dependencies.js'
import { createKeiExpClient, type KeiExpArtifact } from './kei-exp.js'
import { createExtractionJobExecutor } from './module.js'

const schema = {
  recordDescription: 'Article records.',
  schemaNodes: [{ id: 'title', name: 'title', type: 'string' as const }, { id: 'year', name: 'year', type: 'integer' as const }],
}
const runId = parsedDocument.document.document_id
const ack = { id: 'extraction-1', run_id: runId, status: 'queued', generation: 'g1' }
function artifact(overrides: Partial<KeiExpArtifact> = {}): KeiExpArtifact {
  return {
    extraction_version: 1, run_id: runId, generation: 'g1', digest: 'digest', fingerprint: 'fingerprint',
    strategy: 'article', model: 'selected-model', prompt_version: 'v1', schema,
    options: { strategy: 'article', model: 'selected-model' }, started: '2026-09-22T00:00:00Z', seconds: 1.25,
    complete: false, records: [{ title: 'Alpha', year: null }],
    evidence: [{ path: ['records', 0, 'title'], segment: 'p1_s0', page: 1, bbox_pt: [1, 2, 3, 4], verbatim: true, hits: 1, linked_by: 'lexical' }],
    ungrounded: [], issues: [{ code: 'missing_value', detail: 'No year', record: 0, path: ['records', 0, 'year'] }],
    calls: 3, tokens: { input: 20, output: 10 }, ...overrides,
  }
}
function harness(responses: Array<Response | Error>, strategy: 'ARTICLE' | 'CATALOG' = 'ARTICLE', document = parsedDocument) {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const inputs: ExtractionInputReader = {
    readExtractionAttempt: async () => null,
    loadExtractionInputs: async (sourceRepresentationRevisionId, schemaRevisionId) => ({
      sourceDocumentId: 'source', projectContextId: 'project', sourceRepresentationRevisionId, schemaRevisionId,
      schemaTree: schema, parsedDocument: document,
    }),
  }
  const keiExp = createKeiExpClient({
    url: 'http://kei-exp:8001/', model: async () => 'selected-model', pollIntervalMs: 1,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init })
      const next = responses.shift()
      assert.ok(next, 'unexpected extra request')
      if (next instanceof Error) throw next
      return next
    },
  })
  const execute = createExtractionJobExecutor({ inputs, keiExp })
  const input = { kind: 'fresh' as const, extractionId: randomUUID(), sourceRepresentationRevisionId: randomUUID(), schemaRevisionId: randomUUID(), strategy }
  return {
    requests, input, execute,
    run: (signal = new AbortController().signal) => execute(input, signal),
  }
}
const json = (body: unknown, status = 200) => Response.json(body, { status })

describe('kei-exp extraction relay', () => {
  it('posts the pinned schema and maps artifact evidence, completeness, diagnostics and attribution', async () => {
    const h = harness([json(ack, 202), json(artifact())])
    const result = await h.run()
    assert.equal(h.requests[0].url, `http://kei-exp:8001/api/runs/${encodeURIComponent(runId)}/extract`)
    assert.deepEqual(JSON.parse(h.requests[0].init!.body as string), { schema, options: { strategy: 'article', model: 'selected-model' } })
    assert.equal(h.requests[1].url, `http://kei-exp:8001/api/runs/${encodeURIComponent(runId)}/extractions/extraction-1`)
    assert.deepEqual(result.result, { records: [{ title: 'Alpha', year: null }] })
    assert.deepEqual(result.evidence, [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'a_p1_s0', verbatim: true, lexicalHits: 1, linkedBy: 'lexical' }])
    assert.equal(result.complete, false)
    assert.equal(result.reviewable, true)
    assert.equal(result.outcome, 'SUCCEEDED')
    assert.deepEqual(result.modelAttribution, { provider: 'kei-exp', modelId: 'selected-model' })
    assert.deepEqual(result.diagnostics, { phase: 'persisting', durationMs: 1250, modelCalls: 3, inputTokens: 20, outputTokens: 10, finishReason: null, ungroundedPaths: [], groundingIssues: artifact().issues, groundingBatches: [], catalog: null, retry: null })
  })

  it('relays catalog, zero/multiple records, ungrounded paths and model-linked evidence', async () => {
    for (const records of [[], [{ title: 'A', year: 1901 }, { title: 'B', year: null }]]) {
      const value = artifact({ strategy: 'catalog', complete: true, records, model: null, evidence: [], ungrounded: records.length ? [['records', 0, 'title']] : [] })
      const h = harness([json(ack, 202), json(value)], 'CATALOG')
      const result = await h.run()
      assert.equal(JSON.parse(h.requests[0].init!.body as string).options.strategy, 'catalog')
      assert.deepEqual(result.result, { records })
      assert.deepEqual(result.diagnostics.ungroundedPaths, value.ungrounded)
      assert.equal(result.modelAttribution, null)
      assert.equal(result.complete, true)
    }
    const value = artifact()
    value.evidence[0].linked_by = 'model'
    assert.equal((await harness([json(ack, 202), json(value)]).run()).evidence![0].linkedBy, undefined)
  })

  it('waits through queued/running, 429, 503 and network errors on both endpoints', async () => {
    const h = harness([
      json({}, 503), new TypeError('network'), json({}, 429), json(ack, 202),
      json({ status: 'queued' }, 202), json({ status: 'running' }), json({}, 429),
      new TypeError('network'), json({}, 503), json(artifact()),
    ])
    await h.run()
    assert.equal(h.requests.length, 10)
    assert.equal(h.requests.filter(r => r.init?.method === 'POST').length, 4)
  })

  it('fails on nonretryable HTTP responses and malformed or mismatched artifacts', async () => {
    for (const status of [404, 409, 400, 500]) {
      const h = harness([json({}, status)])
      await assert.rejects(h.run(), { code: 'extraction_failed' })
      assert.equal(h.requests.length, 1)
    }
    for (const value of [{}, artifact({ run_id: 'other' }), artifact({ generation: 'other' }), artifact({ strategy: 'catalog' }), artifact({ schema: { ...schema, recordDescription: 'Other schema' } }), { status: 'failed' }]) {
      await assert.rejects(harness([json(ack, 202), json(value)]).run(), { code: 'invalid_model_output' })
    }
    await assert.rejects(harness([json({ ...ack, run_id: 'other' }, 202)]).run(), { code: 'invalid_model_output' })
    await assert.rejects(harness([new Response('not json')]).run(), { code: 'invalid_model_output' })
  })

  it('cancels polling and does not POST when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = harness([])
    await assert.rejects(h.run(controller.signal), { name: 'AbortError' })
    assert.equal(h.requests.length, 0)
    const polling = harness([json(ack, 202), json({ status: 'running' })])
    await assert.rejects(polling.run(AbortSignal.timeout(2)), error => error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
  })

  it('retries an interrupted response body and bounds transient failures by the catalog deadline', async (t) => {
    const broken = new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('connection reset')) } }))
    await harness([json(ack, 202), broken, json(artifact())]).run()
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
    await assert.rejects(client.extract({ runId, schema, strategy: 'catalog', signal: new AbortController().signal }),
      error => error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    assert.equal(deadlines[0], 3 * 60 * 60 * 1000)
    assert.ok(calls >= 1)
  })

  it('refuses an artifact from a newer generation than the pinned Source Representation', async () => {
    const document = structuredClone(parsedDocument)
    document.preprocessing.profile = 'kei-exp'
    document.preprocessing.preprocess_id = `kei-exp:${runId}:g1`
    for (const anchor of document.evidence_index.anchors) anchor.preprocess_id = document.preprocessing.preprocess_id
    const h = harness([json({ ...ack, generation: 'g2' }, 202), json(artifact({ generation: 'g2' }))], 'ARTICLE', document)
    await assert.rejects(h.run(), { code: 'invalid_source_representation' })
    await harness([json(ack, 202), json(artifact())], 'ARTICLE', document).run()
  })

  it('keeps batch identity and rejects unsupported targeted retries', async () => {
    const h = harness([json(ack, 202), json(artifact())])
    const result = await h.execute({ ...h.input, kind: 'batch-member', batchExtractionId: 'batch' }, new AbortController().signal)
    assert.equal(result.batchExtractionId, 'batch')
    await assert.rejects(h.execute({ kind: 'retry', extractionId: 'retry', retryOfId: 'parent', retryDocument: false, rediscover: true, retryRecordStartBlockIds: [] }, new AbortController().signal), { code: 'invalid_retry' })
  })
})
