import { describe, expect, it, vi } from 'vitest'
import type {
  BatchExtractionRecord,
  CreateBatchExtractionInput,
  ProjectStore,
} from '../../../packages/db/src/project-store.js'
import {
  batchExtractionListResponseSchema,
  batchExtractionProgress,
  batchExtractionResponseSchema,
} from '../shared/batchExtraction.contract.js'
import { createBatchExtractionsApi } from './batch_extractions.js'

const PROJECT = '51000000-0000-4000-8000-000000000001'
const BATCH = '51000000-0000-4000-8007-000000000001'
const REVISION = '51000000-0000-4000-8004-000000000001'
const SCHEMA = '51000000-0000-4000-8003-000000000001'
const REVIEWED = '51000000-0000-4000-8001-000000000001'
const FAILED = '51000000-0000-4000-8001-000000000002'
const PENDING = '51000000-0000-4000-8001-000000000003'
const CANCELLED = '51000000-0000-4000-8001-000000000004'
const representation = (suffix: string) =>
  `51000000-0000-4000-8002-00000000000${suffix}`

const batch: BatchExtractionRecord = {
  batchExtractionId: BATCH,
  projectContextId: PROJECT,
  schemaRevisionId: REVISION,
  extractionSchemaId: SCHEMA,
  extractionSchemaName: 'Places',
  schemaRevisionNumber: 4,
  strategy: 'CATALOG',
  createdAt: new Date('2026-08-14T10:42:00Z'),
  members: [
    {
      sourceDocumentId: REVIEWED,
      sourceRepresentationRevisionId: representation('1'),
      latestExtraction: {
        extractionId: '51000000-0000-4000-8006-000000000001',
        outcome: 'SUCCEEDED',
        complete: true,
        reviewable: true,
        createdAt: new Date('2026-08-14T10:43:00Z'),
        reviewedAt: new Date('2026-08-14T10:50:00Z'),
        failure: null,
      },
    },
    {
      sourceDocumentId: FAILED,
      sourceRepresentationRevisionId: representation('2'),
      latestExtraction: {
        extractionId: '51000000-0000-4000-8006-000000000002',
        outcome: 'FAILED',
        complete: null,
        reviewable: false,
        createdAt: new Date('2026-08-14T10:44:00Z'),
        reviewedAt: null,
        failure: {
          code: 'extraction_failed',
          message: 'The model returned no records.',
          internal: 'postgresql://secret',
        },
      },
    },
    // Selected but not run yet: progress must not claim it.
    {
      sourceDocumentId: PENDING,
      sourceRepresentationRevisionId: representation('3'),
      latestExtraction: null,
    },
    {
      sourceDocumentId: CANCELLED,
      sourceRepresentationRevisionId: representation('4'),
      latestExtraction: {
        extractionId: '51000000-0000-4000-8006-000000000003',
        outcome: 'CANCELLED',
        complete: null,
        reviewable: false,
        createdAt: new Date('2026-08-14T10:45:00Z'),
        reviewedAt: null,
        failure: null,
      },
    },
  ],
}

function handler(
  overrides: Partial<
    Pick<ProjectStore, 'createBatchExtraction' | 'listBatchExtractions'>
  > = {},
) {
  const store = {
    createBatchExtraction: vi.fn(async () => ({
      status: 'created' as const,
      batch,
    })),
    listBatchExtractions: vi.fn(async () => [batch]),
    ...overrides,
  }
  return { handle: createBatchExtractionsApi(store), store }
}

const open = (body: unknown) =>
  new Request('http://test/api/batch-extractions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const request = {
  projectContextId: PROJECT,
  schemaRevisionId: REVISION,
  strategy: 'CATALOG',
  sourceDocumentIds: [REVIEWED, FAILED, PENDING],
}

describe('/api/batch-extractions', () => {
  it('opens one Batch Extraction over the researcher selection', async () => {
    const fixture = handler()
    const response = await fixture.handle(open(request))

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(fixture.store.createBatchExtraction).toHaveBeenCalledWith(PROJECT, {
      batchExtractionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      schemaRevisionId: REVISION,
      strategy: 'CATALOG',
      sourceDocumentIds: [REVIEWED, FAILED, PENDING],
    })
    const { batchExtraction, disposition } = batchExtractionResponseSchema.parse(
      await response.json(),
    )
    expect(disposition).toBe('created')
    expect(batchExtraction.createdAt).toBe('2026-08-14T10:42:00.000Z')
    expect(batchExtraction.members).toHaveLength(4)
  })

  it('derives one order-independent ID and reports a matching running batch', async () => {
    let firstId = ''
    let secondId = ''
    const firstCreate = vi.fn(async (_: string, input: CreateBatchExtractionInput) => {
      firstId = input.batchExtractionId
      return { status: 'replayed' as const, batch }
    })
    const secondCreate = vi.fn(async (_: string, input: CreateBatchExtractionInput) => {
      secondId = input.batchExtractionId
      return {
        status: 'created' as const,
        batch,
      }
    })
    const first = handler({
      createBatchExtraction: firstCreate,
    })
    const second = handler({ createBatchExtraction: secondCreate })
    const response = await first.handle(open(request))
    await second.handle(
      open({ ...request, sourceDocumentIds: [...request.sourceDocumentIds].reverse() }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ disposition: 'running' })
    expect(firstId).toBe(secondId)
  })

  it('reports failed matches for automatic retry and force opens a fresh batch', async () => {
    const failedBatch = { ...batch, members: [batch.members[1]] }
    const ids: string[] = []
    const create = vi.fn(async (_: string, input: CreateBatchExtractionInput) => {
      ids.push(input.batchExtractionId)
      return ids.length === 1
        ? { status: 'replayed' as const, batch: failedBatch }
        : { status: 'created' as const, batch }
    })
    const fixture = handler({
      createBatchExtraction: create,
    })
    const retry = await fixture.handle(open(request))
    const fingerprintId = ids[0]
    const forced = await fixture.handle(open({ ...request, force: true }))
    const forcedId = ids[1]

    expect(await retry.json()).toMatchObject({ disposition: 'retry' })
    expect(forced.status).toBe(201)
    expect(forcedId).not.toBe(fingerprintId)
  })

  it('lists Batch Extractions with truthful, un-run-aware progress', async () => {
    const fixture = handler()
    const response = await fixture.handle(
      new Request(
        `http://test/api/batch-extractions?projectContextId=${PROJECT}&limit=10`,
      ),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(fixture.store.listBatchExtractions).toHaveBeenCalledWith(PROJECT, 10)
    const [listed] = batchExtractionListResponseSchema.parse(body)
      .batchExtractions
    expect(batchExtractionProgress(listed)).toEqual({
      total: 4,
      extracted: 3,
      pending: 1,
      failed: 1,
      cancelled: 1,
      reviewed: 1,
      unreviewable: 0,
      needsReview: 0,
    })
    expect(listed.members[1].latestExtraction?.failureMessage).toBe(
      'The model returned no records.',
    )
    // Only the researcher-facing sentence leaves the server.
    expect(JSON.stringify(body)).not.toContain('secret')
  })

  it('rejects an invalid request, an unknown Project Context, and an unowned selection', async () => {
    const fixture = handler()
    expect((await fixture.handle(open({ ...request, sourceDocumentIds: [] }))).status).toBe(422)
    expect((await fixture.handle(open({ ...request, strategy: 'BOTH' }))).status).toBe(422)
    expect(
      (await fixture.handle(new Request('http://test/api/batch-extractions'))).status,
    ).toBe(422)
    expect(
      (
        await handler({ createBatchExtraction: vi.fn(async () => null) }).handle(
          open(request),
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await handler({
          createBatchExtraction: vi.fn(async () => ({
            status: 'invalid' as const,
          })),
        }).handle(open(request))
      ).status,
    ).toBe(422)
    expect(
      (
        await handler({ listBatchExtractions: vi.fn(async () => null) }).handle(
          new Request(
            `http://test/api/batch-extractions?projectContextId=${PROJECT}`,
          ),
        )
      ).status,
    ).toBe(404)
  })

  it('sanitizes an unreadable persisted read', async () => {
    const unavailable = await handler({
      listBatchExtractions: vi.fn(async () => {
        throw new Error('postgresql://secret')
      }),
    }).handle(
      new Request(`http://test/api/batch-extractions?projectContextId=${PROJECT}`),
    )

    expect(unavailable.status).toBe(503)
    expect(await unavailable.text()).not.toContain('secret')
  })
})
