import { describe, expect, it, vi } from 'vitest'
import type {
  ProjectStore,
  StoredExtractionAttempt,
  TerminalExtractionInput,
} from '../../../packages/db/src/project-store.js'
import parsedDocument from '../src/assets/parsed_document.v2.json'
import {
  extractionAttemptSchema,
  extractionReadResponseSchema,
} from '../shared/extraction.contract.js'
import type { ParsedContentBlock, ParsedDocument } from '../shared/parsedDocument.js'
import { createExtractionsApi } from './extractions.js'

const extractionId = '11111111-1111-4111-8111-111111111111'
const sourceDocumentId = '22222222-2222-4222-8222-222222222222'
const representationId = '33333333-3333-4333-8333-333333333333'
const schemaRevisionId = '44444444-4444-4444-8444-444444444444'
const alternateSchemaId = '55555555-5555-4555-8555-555555555555'

function request(
  id = extractionId,
  schemaId = schemaRevisionId,
  strategy: 'ARTICLE' | 'CATALOG' = 'ARTICLE',
  extra: Record<string, unknown> = {},
) {
  const body = extra.retryOfId
    ? { id, ...extra }
    : {
        id,
        sourceRepresentationRevisionId: representationId,
        schemaRevisionId: schemaId,
        strategy,
        ...extra,
      }
  return new Request('http://studio/api/extractions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function fakeStore(schemaNodes: unknown) {
  const schemaTree = {
    recordDescription: 'One representative source record.',
    schemaNodes,
  }
  const attempts = new Map<string, StoredExtractionAttempt>()
  const persist = vi.fn(async (input: TerminalExtractionInput) => {
    const existing = attempts.get(input.extractionId)
    if (existing) return { status: 'replayed' as const, attempt: existing }
    const attempt: StoredExtractionAttempt = {
      ...input,
      sourceRepresentationRevisionNumber: 1,
      extractionSchemaId: '66666666-6666-4666-8666-666666666666',
      schemaRevisionNumber: 1,
      schemaTree,
      createdAt: new Date('2026-08-10T00:00:00Z'),
      reviewedAt: null,
      reviewDecisions: [],
    }
    attempts.set(input.extractionId, attempt)
    return { status: 'created' as const, attempt }
  })
  const store: Pick<
    ProjectStore,
    | 'finalizeExtractionReview'
    | 'getExtractionInputs'
    | 'getExtractionAttempt'
    | 'getSourceRepresentation'
    | 'persistExtractionAttempt'
  > = {
    async getExtractionInputs(_representationId, schemaId) {
      if (schemaId !== schemaRevisionId) return null
      return {
        sourceDocumentId,
        projectContextId: '77777777-7777-4777-8777-777777777777',
        sourceRepresentationRevisionId: representationId,
        schemaRevisionId,
        schemaTree,
        descriptor: { artifactReference: 'a'.repeat(64), artifactSha256: 'a'.repeat(64) },
      }
    },
    async getExtractionAttempt(id) {
      return attempts.get(id) ?? null
    },
    async getSourceRepresentation() {
      return { artifactReference: 'a'.repeat(64), artifactSha256: 'a'.repeat(64) }
    },
    persistExtractionAttempt: persist,
    async finalizeExtractionReview() {
      return { status: 'invalid' }
    },
  }
  return { store, attempts, persist }
}

const target = {
  profile: 'nuextract-raw' as const,
  modelId: 'fixture',
  baseUrl: 'http://127.0.0.1:11434',
  authorization: null,
  temperatureSupported: true,
  attribution: { provider: 'ollama' as const, modelId: 'fixture' },
}

function generated(
  result: Record<string, unknown>,
  finishReason = 'stop',
) {
  return {
    result,
    reasoning: null,
    pages: 1,
    modelAttribution: { provider: 'ollama' as const, modelId: 'fixture' },
    metadata: {
      finishReason,
      inputTokens: 10,
      outputTokens: 4,
      durationMs: 1,
    },
  }
}

function catalogDocument(labels = ['First', 'Second']) {
  const document = structuredClone(parsedDocument) as ParsedDocument
  const existing = document.content_stream[0]
  const blocks: ParsedContentBlock[] = [existing]
  for (const [index, text] of labels.entries())
    blocks.push({
      ...existing,
      block_id: `heading-${index}`,
      kind: 'heading',
      text,
      markdown_span: null,
      level: 1,
    })
  document.content_stream = blocks
  document.pages[0].ordered_content = blocks.map((block: { block_id: string }) => block.block_id)
  return document
}

it('rejects retry requests that include caller pins before doing any work', async () => {
  const { store, persist } = fakeStore([{ id: 'title', name: 'title', type: 'string' }])
  const extract = vi.fn()
  const handler = createExtractionsApi({
    store,
    readSource: async () => catalogDocument(),
    resolveTarget: async () => target,
    extract,
  })

  const response = await handler(new Request('http://studio/api/extractions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'abababab-abab-4aba-8aba-abababababab',
      retryOfId: extractionId,
      sourceRepresentationRevisionId: representationId,
      schemaRevisionId,
      strategy: 'CATALOG',
    }),
  }))

  expect(response.status).toBe(422)
  expect(extract).not.toHaveBeenCalled()
  expect(persist).not.toHaveBeenCalled()
})

describe('GET /api/extractions/:id', () => {
  function stored(
    overrides: Partial<StoredExtractionAttempt> = {},
  ): StoredExtractionAttempt {
    return {
      extractionId,
      sourceDocumentId,
      sourceRepresentationRevisionId: representationId,
      sourceRepresentationRevisionNumber: 1,
      schemaRevisionId,
      extractionSchemaId: '66666666-6666-4666-8666-666666666666',
      schemaRevisionNumber: 1,
      schemaTree: {
        recordDescription: 'One representative source record.',
        schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
      },
      createdAt: new Date('2026-08-10T00:00:00Z'),
      reviewedAt: null,
      strategy: 'ARTICLE',
      outcome: 'SUCCEEDED',
      complete: true,
      modelAttribution: { provider: 'ollama', modelId: 'fixture' },
      diagnostics: {
        phase: 'grounding',
        durationMs: 1,
        modelCalls: 1,
        finishReason: 'stop',
        inputTokens: 10,
        outputTokens: 4,
        values: null,
        grounding: null,
        catalog: null,
      },
      resultPayload: { records: [{ title: 'Ellekilde' }] },
      evidenceLinks: [
        { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'bundled-anchor' },
      ],
      failure: null,
      reviewable: true,
      retryOfId: null,
      batchExtractionId: null,
      reviewDecisions: [],
      ...overrides,
    }
  }

  const read = (attempt: StoredExtractionAttempt | null) => {
    const { store } = fakeStore([{ id: 'title', name: 'title', type: 'string' }])
    return createExtractionsApi({
      store: { ...store, getExtractionAttempt: async () => attempt },
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract: vi.fn(),
    })(new Request(`http://studio/api/extractions/${extractionId}`))
  }

  it('answers the Review Decisions the stored Evidence requires', async () => {
    const response = await read(stored())
    const body = extractionReadResponseSchema.parse(await response.json())

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body.extraction.extractionId).toBe(extractionId)
    expect(body.pendingReviewDecisions).toEqual([
      {
        evidenceAnchorId: 'bundled-anchor',
        reviewedOccurrenceIds: ['bundled-occurrence'],
      },
    ])
  })

  it('answers no Review Decisions for an Extraction that cannot be reviewed', async () => {
    const failed = await read(
      stored({
        outcome: 'FAILED',
        complete: null,
        resultPayload: null,
        evidenceLinks: null,
        reviewable: false,
        failure: { code: 'extraction_failed', message: 'Extraction failed.' },
      }),
    )

    expect(
      extractionReadResponseSchema.parse(await failed.json())
        .pendingReviewDecisions,
    ).toEqual([])
    expect((await read(null)).status).toBe(404)
  })
})

describe('server-owned Article extraction route', () => {
  it('runs the whole-source values call for an empty schema', async () => {
    const { store } = fakeStore([])
    const extract = vi.fn().mockResolvedValue(generated({ records: [{}] }))

    const response = await createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })(request())

    expect(response.status).toBe(201)
    expect(extract).toHaveBeenCalledOnce()
    expect(extract.mock.calls[0][0].template).toEqual({ records: [{}] })
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      resultPayload: { records: [{}] },
      diagnostics: { modelCalls: 1 },
    })
  })

  it('executes Catalog through the server-owned lifecycle', async () => {
    const { store, persist } = fakeStore([])
    const readSource = vi.fn(async () => parsedDocument)
    const resolveTarget = vi.fn(async () => target)
    const extract = vi.fn()

    const response = await createExtractionsApi({
      store,
      readSource,
      resolveTarget,
      extract,
    })(request(extractionId, schemaRevisionId, 'CATALOG'))

    expect(response.status).toBe(201)
    expect(readSource).toHaveBeenCalledOnce()
    expect(resolveTarget).toHaveBeenCalledOnce()
    expect(extract).toHaveBeenCalledOnce()
    expect(persist).toHaveBeenCalledOnce()
  })

  it('schedules one discovery call and one values call per canonical record slice', async () => {
    const { store } = fakeStore([{ id: 'title', name: 'title', type: 'string' }])
    const document = catalogDocument()
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ starts: ['First', 'Second'] }))
      .mockResolvedValueOnce(generated({ records: [{ title: 'A' }] }))
      .mockResolvedValueOnce(generated({ records: [{ title: 'B' }] }))
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
      .mockResolvedValueOnce(generated({ links: { C2: 'E1' } }))

    const response = await createExtractionsApi({
      store,
      readSource: async () => document,
      resolveTarget: async () => target,
      extract,
    })(request('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', schemaRevisionId, 'CATALOG'))

    expect(response.status).toBe(201)
    expect(extract).toHaveBeenCalledTimes(5)
    expect(extract.mock.calls[1][0].document.markdown).toContain('First')
    expect(extract.mock.calls[1][0].document.markdown).not.toContain('Second')
    expect(extract.mock.calls[2][0].document.markdown).toContain('Second')
    const resultBody = await response.json()
    expect(resultBody).toMatchObject({
      strategy: 'CATALOG',
      outcome: 'SUCCEEDED',
      resultPayload: { records: [{ title: 'A' }, { title: 'B' }] },
      diagnostics: {
        catalog: {
          stages: [
            { stage: 'document-values', outcome: 'not_attempted' },
            { stage: 'discovery', outcome: 'succeeded', calls: 1 },
            { stage: 'record-values', outcome: 'succeeded', calls: 2 },
            { stage: 'grounding', outcome: 'succeeded', calls: 2 },
          ],
        },
      },
    })
  })

  it('keeps successful records around an individual record failure', async () => {
    const { store } = fakeStore([{ id: 'title', name: 'title', type: 'string' }])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ starts: ['First', 'Second', 'Third'] }))
      .mockResolvedValueOnce(generated({ records: [{ title: 'A' }] }))
      .mockRejectedValueOnce(new Error('record unavailable'))
      .mockResolvedValueOnce(generated({ records: [{ title: 'C' }] }))
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
      .mockResolvedValueOnce(generated({ links: { C2: 'E1' } }))

    const response = await createExtractionsApi({
      store,
      readSource: async () => catalogDocument(['First', 'Second', 'Third']),
      resolveTarget: async () => target,
      extract,
    })(request('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', schemaRevisionId, 'CATALOG'))

    await expect(response.json()).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      complete: false,
      resultPayload: { records: [{ title: 'A' }, { title: 'C' }] },
      diagnostics: {
        catalog: {
          records: [
            { ordinal: 0, outcome: 'succeeded' },
            { ordinal: 1, outcome: 'failed', calls: 1 },
            { ordinal: 2, outcome: 'succeeded' },
          ],
        },
      },
    })
    expect(extract).toHaveBeenCalledTimes(6)
  })

  it('fails discovery without attempting record values', async () => {
    const { store } = fakeStore([{ id: 'title', name: 'title', type: 'string' }])
    const extract = vi.fn().mockResolvedValueOnce(generated({ starts: ['Missing'] }))
    const response = await createExtractionsApi({
      store,
      readSource: async () => catalogDocument(),
      resolveTarget: async () => target,
      extract,
    })(request('cccccccc-cccc-4ccc-8ccc-cccccccccccc', schemaRevisionId, 'CATALOG'))

    const body = extractionAttemptSchema.parse(await response.json())
    expect(body).toMatchObject({ outcome: 'FAILED', resultPayload: null })
    expect(body.diagnostics.catalog!.records).toEqual([])
    expect(body.diagnostics.catalog!.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'discovery', outcome: 'failed', calls: 1, failureCode: 'unknown_label' }),
        expect.objectContaining({ stage: 'record-values', outcome: 'not_attempted', calls: 0 }),
      ]),
    )
    expect(extract).toHaveBeenCalledOnce()
  })

  it('caps Catalog boundaries at 100 without package-only record calls', async () => {
    const labels = Array.from({ length: 101 }, (_, index) => `Record ${index + 1}`)
    const { store } = fakeStore([
      { id: 'filename', name: 'filename', type: 'string', valueSource: 'source-filename' },
    ])
    const extract = vi.fn().mockResolvedValueOnce(generated({ starts: labels }))
    const response = await createExtractionsApi({
      store,
      readSource: async () => catalogDocument(labels),
      resolveTarget: async () => target,
      extract: extract as never,
    })(request('dddddddd-dddd-4ddd-8ddd-dddddddddddd', schemaRevisionId, 'CATALOG'))

    const body = extractionAttemptSchema.parse(await response.json())
    expect(body).toMatchObject({ outcome: 'SUCCEEDED', complete: false })
    expect(body.resultPayload!.records).toHaveLength(100)
    expect(body.diagnostics.catalog!.records).toHaveLength(101)
    expect(body.diagnostics.catalog!.records.slice(0, 100).every((record) =>
      record.outcome === 'succeeded' && record.calls === 0,
    )).toBe(true)
    expect(body.diagnostics.catalog!.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'record-values', outcome: 'succeeded', calls: 0 }),
      ]),
    )
    expect(body.diagnostics.catalog!.records[100]).toMatchObject({
      ordinal: 100,
      outcome: 'not_attempted',
      calls: 0,
      failureCode: 'not_attempted_limit',
    })
    expect(extract).toHaveBeenCalledOnce()
  })

  it('extracts document-only fields once and skips record values calls', async () => {
    const { store } = fakeStore([
      { id: 'year', name: 'year', type: 'integer', valueSource: 'document' },
    ])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ records: [{ year: 2026 }] }))
      .mockResolvedValueOnce(generated({ starts: ['First', 'Second'] }))
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
      .mockResolvedValueOnce(generated({ links: { C2: 'E1' } }))
    const response = await createExtractionsApi({
      store,
      readSource: async () => catalogDocument(),
      resolveTarget: async () => target,
      extract,
    })(request('ffffffff-ffff-4fff-8fff-ffffffffffff', schemaRevisionId, 'CATALOG'))

    const body = extractionAttemptSchema.parse(await response.json())
    expect(body.resultPayload).toEqual({ records: [{ year: 2026 }, { year: 2026 }] })
    expect(body.diagnostics.catalog!.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'document-values', outcome: 'succeeded', calls: 1 }),
        expect.objectContaining({ stage: 'record-values', outcome: 'succeeded', calls: 0 }),
      ]),
    )
    expect(extract).toHaveBeenCalledTimes(4)
  })

  it('retries one failed Catalog record and reuses its successful sibling', async () => {
    const parentId = '12121212-1212-4121-8121-121212121212'
    const childId = '13131313-1313-4131-8131-131313131313'
    const { store } = fakeStore([{ id: 'title', name: 'title', type: 'string' }])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ starts: ['First', 'Second'] }))
      .mockResolvedValueOnce(generated({ records: [{ title: 'A' }] }))
      .mockRejectedValueOnce(new Error('record unavailable'))
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
      .mockResolvedValueOnce(generated({ links: { C2: 'E1' } }))
    const handler = createExtractionsApi({
      store,
      readSource: async () => catalogDocument(),
      resolveTarget: async () => target,
      extract,
    })
    expect((await handler(request(parentId, schemaRevisionId, 'CATALOG'))).status).toBe(201)

    extract.mockReset()
    extract
      .mockResolvedValueOnce(generated({ records: [{ title: 'B' }] }))
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
      .mockResolvedValueOnce(generated({ links: { C2: 'E1' } }))
    const response = await handler(
      request(childId, schemaRevisionId, 'CATALOG', {
        retryOfId: parentId,
        retryRecordStartBlockIds: ['heading-1'],
      }),
    )
    const body = extractionAttemptSchema.parse(await response.json())
    expect(response.status).toBe(201)
    expect(body.retryOfId).toBe(parentId)
    expect(body.resultPayload).toEqual({ records: [{ title: 'A' }, { title: 'B' }] })
    expect(body.diagnostics.retry).toMatchObject({
      retryOfId: parentId,
      retryRecordStartBlockIds: ['heading-1'],
    })
    expect(body.diagnostics.catalog!.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ordinal: 0, provenance: 'reused', calls: 0 }),
        expect.objectContaining({ ordinal: 1, provenance: 'executed', calls: 1 }),
      ]),
    )
    expect(extract).toHaveBeenCalledTimes(3)
    expect(extract.mock.calls[0][0].document.markdown).toContain('Second')
  })

  it('can explicitly retry a limit-skipped record without spending reused-call budget', async () => {
    const parentId = '25252525-2525-4252-8252-252525252525'
    const childId = '26262626-2626-4262-8262-262626262626'
    const labels = Array.from({ length: 101 }, (_, index) => `Record ${index + 1}`)
    const { store, attempts } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const boundaries = labels.map((headingText, ordinal) => ({
      startBlockId: `heading-${ordinal}`,
      startContentIndex: ordinal + 1,
      endContentIndex: ordinal + 2,
      headingText,
      headingLevel: 1,
    }))
    attempts.set(parentId, {
      extractionId: parentId,
      sourceDocumentId,
      sourceRepresentationRevisionId: representationId,
      sourceRepresentationRevisionNumber: 1,
      schemaRevisionId,
      extractionSchemaId: '66666666-6666-4666-8666-666666666666',
      schemaRevisionNumber: 1,
      schemaTree: {
        recordDescription: 'One representative source record.',
        schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
      },
      createdAt: new Date('2026-08-10T00:00:00Z'),
      reviewedAt: null,
      strategy: 'CATALOG',
      outcome: 'SUCCEEDED',
      complete: false,
      modelAttribution: target.attribution,
      diagnostics: {
        phase: 'grounding',
        durationMs: 1,
        modelCalls: 100,
        finishReason: null,
        inputTokens: null,
        outputTokens: null,
        values: null,
        grounding: null,
        catalog: {
          stages: [
            ...(['document-values', 'discovery'] as const).map((stage) => ({
              stage,
              provenance: 'executed' as const,
              outcome: stage === 'discovery' ? 'succeeded' as const : 'not_attempted' as const,
              finishReason: null,
              calls: stage === 'discovery' ? 1 : 0,
              inputTokens: null,
              outputTokens: null,
              durationMs: stage === 'discovery' ? 1 : 0,
              failureCode: null,
            })),
            {
              stage: 'record-values',
              provenance: 'executed',
              outcome: 'succeeded',
              finishReason: null,
              calls: 100,
              inputTokens: null,
              outputTokens: null,
              durationMs: 1,
              failureCode: null,
            },
            {
              stage: 'grounding',
              provenance: 'executed',
              outcome: 'succeeded',
              finishReason: null,
              calls: 0,
              inputTokens: null,
              outputTokens: null,
              durationMs: 0,
              failureCode: null,
            },
          ],
          records: boundaries.map((boundary, ordinal) => ({
            ordinal,
            boundary,
            provenance: 'executed' as const,
            outcome: ordinal === 100 ? 'not_attempted' as const : 'succeeded' as const,
            finishReason: null,
            calls: ordinal === 100 ? 0 : 1,
            inputTokens: null,
            outputTokens: null,
            durationMs: ordinal === 100 ? 0 : 1,
            failureCode: ordinal === 100 ? 'not_attempted_limit' : null,
          })),
        },
      },
      resultPayload: { records: Array.from({ length: 100 }, () => ({ title: 'old' })) },
      evidenceLinks: [],
      failure: null,
      reviewable: false,
      retryOfId: null,
      batchExtractionId: null,
      reviewDecisions: [],
    })
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ records: [{ title: 'new' }] }))
      .mockImplementation(async (input: { template: { links?: Record<string, unknown> } }) =>
        generated({
          links: Object.fromEntries(
            Object.keys(input.template.links ?? {}).map((label) => [label, 'E1']),
          ),
        }),
      )
    const handler = createExtractionsApi({
      store,
      readSource: async () => catalogDocument(labels),
      resolveTarget: async () => target,
      extract,
    })

    const response = await handler(
      request(childId, schemaRevisionId, 'CATALOG', {
        retryOfId: parentId,
        retryRecordStartBlockIds: ['heading-100'],
      }),
    )
    const body = extractionAttemptSchema.parse(await response.json())
    expect(response.status).toBe(201)
    expect(body.complete).toBe(true)
    const records = (body.resultPayload as { records: unknown[] }).records
    expect(records).toHaveLength(101)
    expect(records.at(-1)).toEqual({ title: 'new' })
    expect(body.diagnostics.catalog?.records.at(-1)).toEqual(
      expect.objectContaining({ ordinal: 100, outcome: 'succeeded', calls: 1 }),
    )
    expect(extract.mock.calls[0]?.[0].document.markdown).toContain('Record 101')
  })

  it('retries only the immediate parent of a retry child', async () => {
    const parentId = '22222222-2222-4222-8222-222222222222'
    const childId = '23232323-2323-4232-8232-232323232323'
    const grandchildId = '24242424-2424-4242-8242-242424242424'
    const { store, attempts } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(
        generated({ starts: ['First', 'Second'] }, 'grandparent-discovery'),
      )
      .mockResolvedValueOnce(
        generated({ records: [{ title: 'Grandparent' }] }, 'grandparent-record'),
      )
      .mockRejectedValueOnce(new Error('record unavailable'))
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
    const handler = createExtractionsApi({
      store,
      readSource: async () => catalogDocument(),
      resolveTarget: async () => target,
      extract,
    })
    const parentResponse = await handler(request(parentId, schemaRevisionId, 'CATALOG'))
    expect(parentResponse.status).toBe(201)
    const parentBody = extractionAttemptSchema.parse(await parentResponse.json())

    extract.mockReset()
    extract
      .mockResolvedValueOnce(generated({ starts: ['First'] }, 'child-discovery'))
      .mockResolvedValueOnce(
        generated({ records: [{ title: 'Child' }] }, 'child-record'),
      )
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
    const childResponse = await handler(
      request(childId, schemaRevisionId, 'CATALOG', {
        retryOfId: parentId,
        rediscover: true,
      }),
    )
    expect(childResponse.status).toBe(201)
    const childBody = extractionAttemptSchema.parse(await childResponse.json())

    // A grandparent mutation must not affect a retry that names the child.
    attempts.get(parentId)!.resultPayload = {
      records: [{ title: 'Grandparent mutation' }],
    }
    extract.mockReset().mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
    const grandchild = await handler(
      request(grandchildId, schemaRevisionId, 'CATALOG', {
        retryOfId: childId,
      }),
    )
    const body = extractionAttemptSchema.parse(await grandchild.json())
    expect(body.retryOfId).toBe(childId)
    expect(body.diagnostics.retry?.retryOfId).toBe(childId)
    expect(body.resultPayload).toEqual({ records: [{ title: 'Child' }] })
    const parentDiscovery = parentBody.diagnostics.catalog!.stages.find(
      (stage) => stage.stage === 'discovery',
    )!
    const childDiscovery = childBody.diagnostics.catalog!.stages.find(
      (stage) => stage.stage === 'discovery',
    )!
    const parentRecord = parentBody.diagnostics.catalog!.records[0]
    const childRecord = childBody.diagnostics.catalog!.records[0]
    const grandchildDiscovery = body.diagnostics.catalog!.stages.find(
      (stage) => stage.stage === 'discovery',
    )!
    const grandchildRecord = body.diagnostics.catalog!.records[0]
    expect(childDiscovery.finishReason).toBe('child-discovery')
    expect(parentDiscovery.finishReason).toBe('grandparent-discovery')
    expect(grandchildDiscovery.finishReason).toBe(childDiscovery.finishReason)
    expect(grandchildDiscovery.finishReason).not.toBe(parentDiscovery.finishReason)
    expect(childRecord.finishReason).toBe('child-record')
    expect(parentRecord.finishReason).toBe('grandparent-record')
    expect(grandchildRecord.finishReason).toBe(childRecord.finishReason)
    expect(grandchildRecord.finishReason).not.toBe(parentRecord.finishReason)
    expect(extract).toHaveBeenCalledOnce()
  })

  it('performs a grounding-only retry without values or discovery calls', async () => {
    const parentId = '14141414-1414-4141-8141-141414141414'
    const childId = '15151515-1515-4151-8151-151515151515'
    const { store } = fakeStore([{ id: 'title', name: 'title', type: 'string' }])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ starts: ['First'] }))
      .mockResolvedValueOnce(generated({ records: [{ title: 'A' }] }, 'length'))
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
    const handler = createExtractionsApi({
      store,
      readSource: async () => catalogDocument(['First']),
      resolveTarget: async () => target,
      extract,
    })
    expect((await handler(request(parentId, schemaRevisionId, 'CATALOG'))).status).toBe(201)

    extract.mockReset().mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
    const response = await handler(
      request(childId, schemaRevisionId, 'CATALOG', { retryOfId: parentId }),
    )
    const body = extractionAttemptSchema.parse(await response.json())
    expect(body.resultPayload).toEqual({ records: [{ title: 'A' }] })
    expect(body.complete).toBe(false)
    expect(extract).toHaveBeenCalledOnce()
    expect(body.diagnostics.catalog!.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'discovery', provenance: 'reused', calls: 0 }),
        expect.objectContaining({
          stage: 'record-values',
          provenance: 'reused',
          calls: 0,
          finishReason: 'length',
        }),
        expect.objectContaining({ stage: 'grounding', provenance: 'executed', calls: 1 }),
      ]),
    )
    expect(body.diagnostics.catalog!.records).toEqual([
      expect.objectContaining({ provenance: 'reused', calls: 0, finishReason: 'length' }),
    ])
  })

  it('retries failed document metadata while reusing records', async () => {
    const parentId = '16161616-1616-4161-8161-161616161616'
    const childId = '17171717-1717-4171-8171-171717171717'
    const { store } = fakeStore([
      { id: 'year', name: 'year', type: 'integer', valueSource: 'document' },
      { id: 'title', name: 'title', type: 'string' },
    ])
    const extract = vi
      .fn()
      .mockRejectedValueOnce(new Error('metadata unavailable'))
      .mockResolvedValueOnce(generated({ starts: ['First'] }))
      .mockResolvedValueOnce(generated({ records: [{ title: 'A' }] }))
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
    const handler = createExtractionsApi({
      store,
      readSource: async () => catalogDocument(['First']),
      resolveTarget: async () => target,
      extract,
    })
    expect((await handler(request(parentId, schemaRevisionId, 'CATALOG'))).status).toBe(201)

    extract.mockReset()
    extract
      .mockResolvedValueOnce(generated({ records: [{ year: 2026 }] }))
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
    const response = await handler(
      request(childId, schemaRevisionId, 'CATALOG', {
        retryOfId: parentId,
        retryDocument: true,
      }),
    )
    const body = extractionAttemptSchema.parse(await response.json())
    expect(body.resultPayload).toEqual({ records: [{ year: 2026, title: 'A' }] })
    expect(extract).toHaveBeenCalledTimes(2)
    expect(extract.mock.calls[0][0].template).toEqual({ records: [{ year: 'integer' }] })
    expect(body.diagnostics.catalog!.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'document-values', provenance: 'executed', calls: 1 }),
        expect.objectContaining({ stage: 'discovery', provenance: 'reused', calls: 0 }),
      ]),
    )
  })

  it('rediscovers a failed Catalog parent and reruns dependent records', async () => {
    const parentId = '18181818-1818-4181-8181-181818181818'
    const childId = '19191919-1919-4191-8191-191919191919'
    const { store } = fakeStore([{ id: 'title', name: 'title', type: 'string' }])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ starts: ['Missing'] }))
    const handler = createExtractionsApi({
      store,
      readSource: async () => catalogDocument(['First']),
      resolveTarget: async () => target,
      extract,
    })
    expect((await handler(request(parentId, schemaRevisionId, 'CATALOG'))).status).toBe(201)

    extract.mockReset()
    extract
      .mockResolvedValueOnce(generated({ starts: ['First'] }))
      .mockResolvedValueOnce(generated({ records: [{ title: 'A' }] }))
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
    const response = await handler(
      request(childId, schemaRevisionId, 'CATALOG', {
        retryOfId: parentId,
        rediscover: true,
      }),
    )
    const body = extractionAttemptSchema.parse(await response.json())
    expect(body.outcome).toBe('SUCCEEDED')
    expect(body.resultPayload).toEqual({ records: [{ title: 'A' }] })
    expect(extract).toHaveBeenCalledTimes(3)
    expect(body.diagnostics.catalog!.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'discovery', provenance: 'executed', calls: 1 }),
        expect.objectContaining({ stage: 'record-values', provenance: 'executed', calls: 1 }),
      ]),
    )
  })

  it('rejects Article targeted retries', async () => {
    const parentId = '20202020-2020-4202-8202-202020202020'
    const childId = '21212121-2121-4212-8212-212121212121'
    const { store } = fakeStore([])
    const extract = vi.fn().mockResolvedValue(generated({ records: [{}] }))
    const handler = createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })
    expect((await handler(request(parentId))).status).toBe(201)
    const response = await handler(
      request(childId, schemaRevisionId, 'ARTICLE', { retryOfId: parentId }),
    )
    expect(response.status).toBe(422)
    expect(extract).toHaveBeenCalledOnce()
  })

  it('cancels Catalog without persisting records already extracted', async () => {
    const { store, persist } = fakeStore([{ id: 'title', name: 'title', type: 'string' }])
    let rejectRecord!: (error: unknown) => void
    const recordBlocked = new Promise<never>((_, reject) => {
      rejectRecord = reject
    })
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ starts: ['First'] }))
      .mockImplementationOnce(async (input: { signal?: AbortSignal }) => {
        input.signal?.addEventListener('abort', () => rejectRecord(new DOMException('Aborted', 'AbortError')), { once: true })
        return recordBlocked
      })
    const handler = createExtractionsApi({
      store,
      readSource: async () => catalogDocument(),
      resolveTarget: async () => target,
      extract: extract as never,
    })
    const post = handler(request('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', schemaRevisionId, 'CATALOG'))
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(2))
    const cancellation = await handler(
      new Request('http://studio/api/extractions/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', { method: 'DELETE' }),
    )

    expect(cancellation.status).toBe(202)
    await expect(post.then((response) => response.json())).resolves.toMatchObject({
      outcome: 'CANCELLED',
      resultPayload: null,
      evidenceLinks: null,
    })
    expect(persist).toHaveBeenCalledOnce()
  })

  it('preserves root and nested schema field order in the model request', async () => {
    const { store } = fakeStore([
      { id: 'z', name: 'zeta', type: 'string' },
      {
        id: 'g',
        name: 'group',
        type: 'object',
        children: [
          { id: 'b', name: 'beta', type: 'number' },
          { id: 'a', name: 'alpha', type: 'string' },
        ],
      },
      { id: 'a2', name: 'alpha', type: 'boolean' },
    ])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(
        generated({
          records: [
            {
              zeta: 'last alphabetically',
              group: { beta: 2, alpha: 'nested second' },
              alpha: true,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        generated({
          links: { C1: 'NONE', C2: 'NONE', C3: 'NONE', C4: 'NONE' },
        }),
      )

    await createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })(request())

    const template = extract.mock.calls[0][0].template as {
      records: [Record<string, unknown>]
    }
    expect(Object.keys(template.records[0])).toEqual([
      'zeta',
      'group',
      'alpha',
    ])
    expect(
      Object.keys(template.records[0].group as Record<string, unknown>),
    ).toEqual(['beta', 'alpha'])
  })

  it('shares concurrent identical work and rejects mismatched in-flight reuse', async () => {
    const { store, persist } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const readStored = store.getExtractionAttempt.bind(store)
    let releaseLookup!: () => void
    const lookupBlocked = new Promise<void>((resolve) => {
      releaseLookup = resolve
    })
    const lookupStarted = vi.fn()
    store.getExtractionAttempt = vi.fn(async (id) => {
      lookupStarted()
      await lookupBlocked
      return readStored(id)
    })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const extract = vi
      .fn()
      .mockImplementationOnce(async () => {
        await blocked
        return generated({ records: [{ title: 'Ellekilde' }] })
      })
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
    const resolveTarget = vi.fn(async () => target)
    const handler = createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget,
      extract,
    })

    const first = handler(request())
    await vi.waitFor(() => expect(lookupStarted).toHaveBeenCalledOnce())
    const identical = handler(request())
    const mismatchPromise = handler(request(extractionId, alternateSchemaId))
    await vi.waitFor(() =>
      expect(store.getExtractionAttempt).toHaveBeenCalledOnce(),
    )
    const mismatch = await mismatchPromise
    releaseLookup()
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1))
    release()
    const [firstResponse, identicalResponse] = await Promise.all([first, identical])

    expect(mismatch.status).toBe(409)
    expect(firstResponse.status).toBe(201)
    expect(identicalResponse.status).toBe(200)
    expect(extract).toHaveBeenCalledTimes(2)
    expect(resolveTarget).toHaveBeenCalledOnce()
    expect(persist).toHaveBeenCalledOnce()
    await expect(firstResponse.json()).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      reviewable: true,
    })
  })

  it('persists multiple records returned by one Article values call', async () => {
    const { store } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(
        generated({
          records: [{ title: 'Ellekilde' }, { title: 'Tornby' }],
        }),
      )
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
    const response = await createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })(request())

    expect(extract).toHaveBeenCalledTimes(3)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      complete: false,
      reviewable: false,
      resultPayload: {
        records: [{ title: 'Ellekilde' }, { title: 'Tornby' }],
      },
    })
  })

  it('completes an empty result without making it reviewable', async () => {
    const { store } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const extract = vi.fn().mockResolvedValueOnce(generated({ records: [{}] }))
    const response = await createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })(request())

    await expect(response.json()).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      complete: true,
      reviewable: false,
      resultPayload: { records: [{}] },
      evidenceLinks: [],
    })
  })

  it('persists usable length-truncated output as incomplete', async () => {
    const { store } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ records: [{ title: 'Ellekilde' }] }, 'length'))
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
    const response = await createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })(request())

    await expect(response.json()).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      complete: false,
      reviewable: true,
      diagnostics: {
        finishReason: 'length',
        values: expect.objectContaining({
          outcome: 'succeeded',
          finishReason: 'length',
        }),
      },
    })
  })

  it('marks a parseable length-truncated grounding batch incomplete', async () => {
    const { store } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ records: [{ title: 'Ellekilde' }] }))
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }, 'length'))
    const response = await createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })(request())

    await expect(response.json()).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      complete: false,
      reviewable: true,
      resultPayload: { records: [{ title: 'Ellekilde' }] },
      diagnostics: {
        finishReason: 'stop',
        grounding: {
          batches: [expect.objectContaining({ finishReason: 'length' })],
        },
      },
    })
  })

  it('rejects a model-authored foreign anchor by making the attempt unreviewable', async () => {
    const { store } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ records: [{ title: 'Ellekilde' }] }))
      .mockResolvedValueOnce(generated({ links: { C1: 'E999' } }))
    const response = await createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })(request())

    await expect(response.json()).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      complete: false,
      reviewable: false,
      evidenceLinks: [],
      diagnostics: {
        grounding: {
          ungroundedPaths: [['records', 0, 'title']],
          issueCodes: ['unknown_anchor_label'],
        },
      },
    })
  })

  it('retains usable extracted values when a grounding batch fails', async () => {
    const { store } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ records: [{ title: 'Ellekilde' }] }))
      .mockRejectedValueOnce(new Error('grounder unavailable'))
    const response = await createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })(request())

    await expect(response.json()).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      complete: false,
      reviewable: false,
      resultPayload: { records: [{ title: 'Ellekilde' }] },
      evidenceLinks: [],
      diagnostics: {
        modelCalls: 2,
        grounding: {
          ungroundedPaths: [['records', 0, 'title']],
          issueCodes: ['grounding_failed'],
          batches: [expect.objectContaining({ outcome: 'failed' })],
        },
      },
    })
  })

  it('persists cancellation before the POST returns', async () => {
    const { store, persist } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const extract = vi.fn((_input: unknown) =>
      new Promise((_, reject) => {
        const signal = (_input as { signal: AbortSignal }).signal
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
    )
    const handler = createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract: extract as never,
    })
    const post = handler(request())
    await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce())
    const cancelled = await handler(
      new Request(`http://studio/api/extractions/${extractionId}`, { method: 'DELETE' }),
    )
    const response = await post

    expect(cancelled.status).toBe(202)
    expect(persist).toHaveBeenCalledOnce()
    await expect(response.json()).resolves.toMatchObject({ outcome: 'CANCELLED' })
    const replay = await handler(request())
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ outcome: 'CANCELLED' })
    expect(extract).toHaveBeenCalledOnce()
  })

  it('cancels a fresh operation while its idempotency lookup is pending', async () => {
    const { store } = fakeStore([])
    const readStored = store.getExtractionAttempt.bind(store)
    let releaseLookup!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseLookup = resolve
    })
    const lookupStarted = vi.fn()
    store.getExtractionAttempt = vi.fn(async (id) => {
      lookupStarted()
      await blocked
      return readStored(id)
    })
    const readSource = vi.fn(async () => parsedDocument)
    const handler = createExtractionsApi({
      store,
      readSource,
      resolveTarget: async () => target,
      extract: vi.fn(),
    })

    const post = handler(request())
    await vi.waitFor(() => expect(lookupStarted).toHaveBeenCalledOnce())
    const cancellation = handler(
      new Request(`http://studio/api/extractions/${extractionId}`, {
        method: 'DELETE',
      }),
    )
    releaseLookup()

    expect((await cancellation).status).toBe(202)
    await expect((await post).json()).resolves.toMatchObject({
      outcome: 'CANCELLED',
    })
    expect(readSource).not.toHaveBeenCalled()
  })

  it('persists cancellation when the final grounding call resolves after abort', async () => {
    const { store } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    let releaseGrounding!: () => void
    const groundingBlocked = new Promise<void>((resolve) => {
      releaseGrounding = resolve
    })
    const groundingStarted = vi.fn()
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ records: [{ title: 'Ellekilde' }] }))
      .mockImplementationOnce(async () => {
        groundingStarted()
        await groundingBlocked
        return generated({ links: { C1: 'E1' } })
      })
    const handler = createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })

    const post = handler(request())
    await vi.waitFor(() => expect(groundingStarted).toHaveBeenCalledOnce())
    const cancellation = await handler(
      new Request(`http://studio/api/extractions/${extractionId}`, {
        method: 'DELETE',
      }),
    )
    releaseGrounding()

    expect(cancellation.status).toBe(202)
    await expect((await post).json()).resolves.toMatchObject({
      outcome: 'CANCELLED',
      resultPayload: null,
      evidenceLinks: null,
    })
  })

  it('does not expose a stored replay as cancellable work', async () => {
    const { store } = fakeStore([])
    const extract = vi.fn().mockResolvedValue(generated({ records: [{}] }))
    const handler = createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })
    expect((await handler(request())).status).toBe(201)

    const readStored = store.getExtractionAttempt.bind(store)
    let releaseLookup!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseLookup = resolve
    })
    const lookupStarted = vi.fn()
    store.getExtractionAttempt = vi.fn(async (id) => {
      lookupStarted()
      await blocked
      return readStored(id)
    })
    const replay = handler(request())
    await vi.waitFor(() => expect(lookupStarted).toHaveBeenCalledOnce())
    const cancellation = handler(
      new Request(`http://studio/api/extractions/${extractionId}`, {
        method: 'DELETE',
      }),
    )
    releaseLookup()
    expect((await cancellation).status).toBe(404)
    expect((await replay).status).toBe(200)
  })

  it('does not respond or accept cancellation after terminal persistence starts', async () => {
    const { store, persist } = fakeStore([])
    let releasePersist!: () => void
    const blocked = new Promise<void>((resolve) => {
      releasePersist = resolve
    })
    const persistStarted = vi.fn()
    store.persistExtractionAttempt = vi.fn(async (input) => {
      persistStarted()
      await blocked
      return persist(input)
    })
    const handler = createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract: vi.fn().mockResolvedValue(generated({ records: [{}] })),
    })
    let responded = false
    const response = handler(request()).then((value) => {
      responded = true
      return value
    })
    await vi.waitFor(() => expect(persistStarted).toHaveBeenCalledOnce())
    expect(responded).toBe(false)
    expect(
      (
        await handler(
          new Request(`http://studio/api/extractions/${extractionId}`, {
            method: 'DELETE',
          }),
        )
      ).status,
    ).toBe(404)
    releasePersist()
    expect((await response).status).toBe(201)
  })

  it('replays a failed attempt without another model call', async () => {
    const { store } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const extract = vi.fn().mockRejectedValue(new Error('provider failed'))
    const handler = createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })
    const failed = await handler(request())
    expect(failed.status).toBe(201)
    await expect(failed.json()).resolves.toMatchObject({ outcome: 'FAILED' })
    const replay = await handler(request())
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ outcome: 'FAILED' })
    expect(extract).toHaveBeenCalledOnce()
  })

  it('overlays source-filename after one content call in schema order', async () => {
    const { store } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
      { id: 'filename', name: 'filename', type: 'string', valueSource: 'source-filename' },
      { id: 'year', name: 'year', type: 'integer', valueSource: 'document' },
    ])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ records: [{ year: 2026, title: 'A title' }] }))
      .mockResolvedValueOnce(generated({ links: { C1: 'NONE', C2: 'NONE' } }))

    const response = await createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })(request())

    expect(extract).toHaveBeenCalledTimes(2)
    await expect(response.json()).resolves.toMatchObject({
      resultPayload: { records: [{ title: 'A title', filename: 'bundled.pdf', year: 2026 }] },
    })
    expect(Object.keys((extract.mock.calls[0][0].template as { records: Record<string, unknown>[] }).records[0])).toEqual([
      'title',
      'year',
    ])
  })

  it('does not call the model for package-only fields', async () => {
    const { store } = fakeStore([
      { id: 'filename', name: 'filename', type: 'string', valueSource: 'source-filename' },
    ])
    const extract = vi.fn()
    const response = await createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })(request())

    expect(extract).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      resultPayload: { records: [{ filename: 'bundled.pdf' }] },
      evidenceLinks: [],
    })
  })

  it('omits source-filename when canonical metadata has no original filename', async () => {
    const { store } = fakeStore([
      { id: 'filename', name: 'filename', type: 'string', valueSource: 'source-filename' },
    ])
    const document = structuredClone(parsedDocument)
    ;(document.document.source as { original_filename: string | null }).original_filename = null
    const extract = vi.fn()
    const response = await createExtractionsApi({
      store,
      readSource: async () => document,
      resolveTarget: async () => target,
      extract,
    })(request())

    expect(extract).not.toHaveBeenCalled()
    const body = extractionAttemptSchema.parse(await response.json())
    expect(body).toMatchObject({ outcome: 'SUCCEEDED', evidenceLinks: [] })
    expect(body.resultPayload).toEqual({ records: [{}] })
  })

  it('rejects unexpected model keys', async () => {
    const { store } = fakeStore([{ id: 'title', name: 'title', type: 'string' }])
    const extract = vi.fn().mockResolvedValue(generated({ records: [{ title: 'A title', extra: 'nope' }] }))
    const response = await createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })(request())

    await expect(response.json()).resolves.toMatchObject({ outcome: 'FAILED' })
  })

  it('rejects review when the stored result does not match its pinned schema', async () => {
    const { store, attempts } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const handler = createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract: vi
        .fn()
        .mockResolvedValueOnce(
          generated({ records: [{ title: 'Ellekilde' }] }),
        )
        .mockResolvedValueOnce(generated({ links: { C1: 'E1' } })),
    })
    expect((await handler(request())).status).toBe(201)
    attempts.get(extractionId)!.resultPayload = {
      records: [{ title: 'Ellekilde', foreign: 'not in the schema' }],
    }
    const finalize = vi.spyOn(store, 'finalizeExtractionReview')

    const response = await handler(
      new Request(
        `http://studio/api/extractions/${extractionId}/review`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reviewDecisions: [] }),
        },
      ),
    )

    expect(response.status).toBe(422)
    expect(finalize).not.toHaveBeenCalled()
  })
})
