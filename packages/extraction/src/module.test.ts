import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import parsedDocument from '../../../prototypes/studio/src/assets/parsed_document.v2.json' with { type: 'json' }
import type { ExtractionPersistence } from './dependencies.js'
import { ExtractionError } from './errors.js'
import type { ExtractionSnapshot } from './types.js'
import { createKeiExpClient, PROGRESS_TIMEOUT_MS } from './kei-exp.js'
import { createExtractionModule } from './module.js'

const json = (body: unknown, status = 200, headers?: Record<string, string>) => Response.json(body, { status, headers })

describe('kei-exp read client', () => {
  function artifactClient(response: Response | Error) {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const client = createKeiExpClient({
      url: 'http://kei-exp:8001/',
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        if (response instanceof Error) throw response
        return response
      },
    })
    return { requests, read: (signal?: AbortSignal) => client.readExtractionArtifact('run-1', 'x-1', signal) }
  }

  it('reads the artifact kei published, byte for byte, from its extraction route', async () => {
    const bytes = new TextEncoder().encode('{"extraction_version":1,  "records":[]}\n')
    const { requests, read } = artifactClient(new Response(bytes, { headers: { 'content-type': 'application/json' } }))
    assert.deepEqual(await read(), bytes)
    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.url, 'http://kei-exp:8001/api/runs/run-1/extractions/x-1')
    assert.equal(requests[0]!.init?.method, 'GET')
  })

  it('a missing artifact fails the Extraction with a fixed message; another refusal names kei\'s reason', async () => {
    await assert.rejects(artifactClient(json({ detail: 'no such extraction' }, 404)).read(), (error: unknown) =>
      error instanceof ExtractionError && error.code === 'extraction_failed' &&
      error.message === 'kei-exp has no published artifact for this Extraction.')
    await assert.rejects(artifactClient(json({ detail: 'bad extraction id' }, 422)).read(), (error: unknown) =>
      error instanceof ExtractionError && error.code === 'invalid_model_output' && error.message.includes('bad extraction id'))
  })

  it('a server failure, an unreachable API or a timeout is transient', async () => {
    for (const response of [json({ detail: 'restarting' }, 503), new TypeError('fetch failed'), new DOMException('timed out', 'TimeoutError')])
      await assert.rejects(artifactClient(response).read(), (error: unknown) =>
        !(error instanceof ExtractionError) && (error as { transient?: unknown }).transient === true)
  })

  it('an aborted read rejects with the caller\'s reason, not as transient', async () => {
    const controller = new AbortController()
    const reason = new Error('the workflow was cancelled')
    controller.abort(reason)
    await assert.rejects(artifactClient(new DOMException('aborted', 'AbortError')).read(controller.signal), (error: unknown) => error === reason)
  })

  it('refuses a run or extraction ID outside kei\'s path component before any request', async () => {
    const requests: string[] = []
    const client = createKeiExpClient({ url: 'http://kei-exp:8001', fetch: async (url) => { requests.push(String(url)); return json({}) } })
    for (const [run, extraction] of [['../x', 'x-1'], ['run-1', 'x/1'], ['run-1', 'x-1\n']])
      await assert.rejects(client.readExtractionArtifact(run!, extraction!), { code: 'invalid_model_output' })
    assert.deepEqual(requests, [])
  })

  function progressClient(response: Response | Error) {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const client = createKeiExpClient({
      url: 'http://kei-exp:8001/',
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        if (response instanceof Error) throw response
        return response
      },
    })
    return { requests, read: (signal?: AbortSignal) => client.readExtractionProgress('run-1', 'x-1', signal) }
  }

  it('reads the progress document from its route, and null while kei has none', async () => {
    const { requests, read } = progressClient(json({ version: 1, strategy: 'catalog' }))
    assert.deepEqual(await read(), { version: 1, strategy: 'catalog' })
    assert.equal(requests[0]!.url, 'http://kei-exp:8001/api/runs/run-1/extractions/x-1/progress')
    assert.equal(requests[0]!.init?.method, 'GET')
    assert.equal(await progressClient(json({ detail: 'no progress yet' }, 404)).read(), null)
  })

  it('a slow, unreachable or failing kei throws a transient error: the caller shows no partial view', async () => {
    for (const response of [new DOMException('timed out', 'TimeoutError'), new TypeError('fetch failed'), json({ detail: 'restarting' }, 503)])
      await assert.rejects(progressClient(response).read(), (error: unknown) => (error as { transient?: unknown }).transient === true)
  })

  it('a progress body cut off or stalled after its headers is transient; a body that is not JSON is invalid output', async () => {
    const failing = new Response(new ReadableStream({ start: (controller) => controller.error(new DOMException('timed out', 'TimeoutError')) }))
    await assert.rejects(progressClient(failing).read(), (error: unknown) => (error as { transient?: unknown }).transient === true)
    await assert.rejects(progressClient(new Response('not json')).read(),
      (error: unknown) => error instanceof ExtractionError && error.code === 'invalid_model_output' && !('transient' in error))
  })

  it('an aborted progress read rejects with the caller\'s reason, not as transient', async () => {
    const controller = new AbortController()
    // As fetch does, the body errors once the request's signal aborts mid-body.
    const cut = new Response(new ReadableStream({ start: (stream) => {
      controller.abort(new Error('closed'))
      stream.error(new DOMException('aborted', 'AbortError'))
    } }))
    const { read } = progressClient(cut)
    await assert.rejects(read(controller.signal), (error: unknown) => (error as Error).message === 'closed' && !('transient' in (error as object)))
  })

  it('every progress read carries a bounded signal: two seconds, the poll interval', async () => {
    const { requests, read } = progressClient(json({}))
    await read()
    assert.equal(PROGRESS_TIMEOUT_MS, 2_000)
    assert.ok(requests[0]!.init?.signal instanceof AbortSignal)
  })

  it('a run or extraction outside kei\'s path component is null before any request', async () => {
    const requests: string[] = []
    const client = createKeiExpClient({ url: 'http://kei-exp:8001', fetch: async (url) => { requests.push(String(url)); return json({}) } })
    assert.equal(await client.readExtractionProgress('../x', 'x-1'), null)
    assert.equal(await client.readExtractionProgress('run-1', 'x-1\n'), null)
    assert.deepEqual(requests, [])
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
      url: 'http://kei-exp:8001/',
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
      url: 'http://kei-exp:8001/',
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
    sourceRepresentationRevisionNumber: 1, preprocessId: 'kei-exp:run-1:g1', schemaRevisionId: randomUUID(),
    extractionSchemaId: randomUUID(), schemaRevisionNumber: 1, strategy: 'ARTICLE', catalogRecipe: null,
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
    saveReviewDraft: async (_: string, draft: unknown) => draft,
  } as unknown as ExtractionPersistence

  it('finalizes a review whose only unaccounted value is the unverified document field', async () => {
    const module = createExtractionModule(persistence)
    const finalized = await module.finalizeReview(extractionId, [decision])
    assert.equal(finalized.disposition, 'reviewed')
  })

  it('saves a draft correction only with its Evidence on a published anchor of the pinned document', async () => {
    const module = createExtractionModule(persistence)
    const correction = (evidenceAnchorId: string) => ({ version: 0, decisions: [{ ...decision, action: 'EDITED' as const,
      reviewedValue: 'Beta', reviewedEvidence: [{ evidenceAnchorId, reviewedOccurrenceIds: ['bundled-occurrence'] }] }] })
    await module.saveReviewDraft(extractionId, correction('bundled-anchor'))
    await assert.rejects(module.saveReviewDraft(extractionId, correction('unpublished-anchor')), { code: 'invalid_review' })
  })
})


