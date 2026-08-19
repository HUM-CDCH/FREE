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
  executeExtraction: (request: Request) => Promise<Response> = async () =>
    Response.json(
      { error: { code: 'not_executed', message: 'Not executed in this test.' } },
      { status: 503 },
    ),
) {
  const store = {
    createBatchExtraction: vi.fn(async () => ({
      status: 'created' as const,
      batch,
    })),
    listBatchExtractions: vi.fn(async () => [batch]),
    ...overrides,
  }
  return {
    handle: createBatchExtractionsApi(store, executeExtraction),
    store,
    executeExtraction,
  }
}

async function terminal(
  request: Request,
  outcome: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED',
) {
  const input = (await request.json()) as {
    id: string
    sourceRepresentationRevisionId: string
    schemaRevisionId: string
    strategy: 'ARTICLE' | 'CATALOG'
    batchExtractionId: string
  }
  const member = batch.members.find(
    (item) =>
      item.sourceRepresentationRevisionId ===
      input.sourceRepresentationRevisionId,
  )
  if (!member) throw new Error('Unknown Batch Extraction member.')
  return Response.json(
    {
      extractionId: input.id,
      sourceDocumentId: member.sourceDocumentId,
      sourceRepresentationRevisionId: input.sourceRepresentationRevisionId,
      schemaRevisionId: input.schemaRevisionId,
      strategy: input.strategy,
      outcome,
      complete: outcome === 'SUCCEEDED' ? true : null,
      modelAttribution:
        outcome === 'SUCCEEDED'
          ? { provider: 'ollama', modelId: 'fixture' }
          : null,
      diagnostics: {
        phase: 'grounding',
        durationMs: 1,
        modelCalls: 1,
        finishReason: 'stop',
        inputTokens: 1,
        outputTokens: 1,
        values: null,
        grounding: null,
        catalog:
          input.strategy === 'CATALOG' ? { stages: [], records: [] } : null,
      },
      failure:
        outcome === 'FAILED'
          ? { code: 'provider_failed', message: 'Provider failed.' }
          : null,
      resultPayload: outcome === 'SUCCEEDED' ? { records: [] } : null,
      evidenceLinks: outcome === 'SUCCEEDED' ? [] : null,
      reviewable: false,
      retryOfId: null,
      batchExtractionId: input.batchExtractionId,
      createdAt: '2026-08-15T10:00:00.000Z',
      reviewedAt: null,
      reviewDecisions: [],
    },
    { status: 201 },
  )
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

  it('runs a created batch sequentially behind the server seam', async () => {
    const pendingBatch = {
      ...batch,
      members: batch.members.slice(1, 3).map((member) => ({
        ...member,
        latestExtraction: null,
      })),
    }
    let inFlight = 0
    let maxInFlight = 0
    const execute = vi.fn(async (memberRequest: Request) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      const result = await terminal(memberRequest)
      inFlight--
      return result
    })
    const fixture = handler(
      {
        createBatchExtraction: vi.fn(async () => ({
          status: 'created' as const,
          batch: pendingBatch,
        })),
      },
      execute,
    )

    const response = await fixture.handle(open(request))
    const opened = batchExtractionResponseSchema.parse(await response.json())

    expect(response.status).toBe(201)
    expect(opened.disposition).toBe('created')
    expect(opened.batchExtraction.members).toHaveLength(2)
    expect(
      opened.batchExtraction.members.every(
        (member) => member.latestExtraction?.outcome === 'SUCCEEDED',
      ),
    ).toBe(true)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(maxInFlight).toBe(1)
  })

  it('resumes pending members and retries failed members without rerunning terminal siblings', async () => {
    const requestedRepresentations: string[] = []
    const execute = vi.fn(async (memberRequest: Request) => {
      const body = (await memberRequest.clone().json()) as {
        sourceRepresentationRevisionId: string
      }
      requestedRepresentations.push(body.sourceRepresentationRevisionId)
      return terminal(memberRequest)
    })
    const fixture = handler(
      {
        createBatchExtraction: vi.fn(async () => ({
          status: 'replayed' as const,
          batch,
        })),
      },
      execute,
    )

    const response = await fixture.handle(open(request))
    const opened = batchExtractionResponseSchema.parse(await response.json())

    expect(response.status).toBe(200)
    expect(opened.disposition).toBe('complete')
    expect(requestedRepresentations).toEqual([
      batch.members[1].sourceRepresentationRevisionId,
      batch.members[2].sourceRepresentationRevisionId,
    ])
    expect(
      opened.batchExtraction.members[0].latestExtraction?.extractionId,
    ).toBe(batch.members[0].latestExtraction?.extractionId)
    expect(
      opened.batchExtraction.members[3].latestExtraction?.extractionId,
    ).toBe(
      batch.members[3].latestExtraction?.extractionId,
    )
    expect(opened.batchExtraction.members[3].latestExtraction?.outcome).toBe(
      'CANCELLED',
    )
  })

  it('joins concurrent replays and keeps the next member ID stable beyond the process map', async () => {
    const failedBatch = { ...batch, members: [batch.members[1]] }
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const ids: string[] = []
    const execute = vi.fn(async (memberRequest: Request) => {
      ids.push(((await memberRequest.clone().json()) as { id: string }).id)
      await blocked
      return terminal(memberRequest)
    })
    const create = vi
      .fn()
      .mockResolvedValueOnce({ status: 'created' as const, batch: failedBatch })
      .mockResolvedValueOnce({ status: 'replayed' as const, batch: failedBatch })
    const fixture = handler({ createBatchExtraction: create }, execute)

    const first = fixture.handle(open(request))
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    const replay = fixture.handle(open(request))
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(execute).toHaveBeenCalledOnce()
    release()
    await Promise.all([first, replay])

    const nextProcessIds: string[] = []
    const nextProcess = handler(
      {
        createBatchExtraction: vi.fn(async () => ({
          status: 'replayed' as const,
          batch: failedBatch,
        })),
      },
      vi.fn(async (memberRequest: Request) => {
        nextProcessIds.push(
          ((await memberRequest.clone().json()) as { id: string }).id,
        )
        return terminal(memberRequest)
      }),
    )
    await nextProcess.handle(open(request))

    expect(ids).toHaveLength(1)
    expect(nextProcessIds).toEqual(ids)
    expect(ids[0]).not.toBe(failedBatch.members[0].latestExtraction?.extractionId)
  })

  it('reports a member request failure and leaves only that member resumable', async () => {
    const pendingBatch = {
      ...batch,
      members: batch.members.slice(1, 3).map((member) => ({
        ...member,
        latestExtraction: null,
      })),
    }
    const execute = vi
      .fn<(request: Request) => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'persistence_unavailable', message: 'Try again.' } },
          { status: 503 },
        ),
      )
      .mockImplementationOnce((memberRequest) => terminal(memberRequest))
    const fixture = handler(
      {
        createBatchExtraction: vi.fn(async () => ({
          status: 'replayed' as const,
          batch: pendingBatch,
        })),
      },
      execute,
    )

    const response = await fixture.handle(open(request))
    const opened = batchExtractionResponseSchema.parse(await response.json())

    expect(execute).toHaveBeenCalledTimes(2)
    expect(opened.disposition).toBe('running')
    expect(opened.batchExtraction.members[0].latestExtraction).toBeNull()
    expect(opened.batchExtraction.members[1].latestExtraction?.outcome).toBe(
      'SUCCEEDED',
    )
    // The member wrote nothing, so this response is the only place it is ever
    // reported — and it carries the Extraction route's own sentence.
    expect(opened.memberFailures).toEqual([
      {
        sourceDocumentId: pendingBatch.members[0].sourceDocumentId,
        message: 'Try again.',
      },
    ])
  })

  it('reports a member failure with no readable reason as a plain sentence', async () => {
    const pendingBatch = {
      ...batch,
      members: batch.members.slice(1, 2).map((member) => ({
        ...member,
        latestExtraction: null,
      })),
    }
    const fixture = handler(
      {
        createBatchExtraction: vi.fn(async () => ({
          status: 'replayed' as const,
          batch: pendingBatch,
        })),
      },
      async () => new Response('not json', { status: 500 }),
    )

    const response = await fixture.handle(open(request))
    const opened = batchExtractionResponseSchema.parse(await response.json())

    expect(opened.memberFailures).toEqual([
      {
        sourceDocumentId: pendingBatch.members[0].sourceDocumentId,
        message: 'The member Extraction did not finish.',
      },
    ])
  })

  it('reports no member failures when every member reaches a terminal write', async () => {
    const fixture = handler({}, (memberRequest) => terminal(memberRequest))

    const response = await fixture.handle(open(request))
    const opened = batchExtractionResponseSchema.parse(await response.json())

    expect(opened.memberFailures).toEqual([])
  })

  it('does not pass client cancellation into server-owned member execution', async () => {
    const pendingBatch = {
      ...batch,
      members: [{ ...batch.members[2], latestExtraction: null }],
    }
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let executionRequest!: Request
    const execute = vi.fn(async (memberRequest: Request) => {
      executionRequest = memberRequest
      await blocked
      return terminal(memberRequest)
    })
    const fixture = handler(
      {
        createBatchExtraction: vi.fn(async () => ({
          status: 'replayed' as const,
          batch: pendingBatch,
        })),
      },
      execute,
    )
    const controller = new AbortController()
    const clientRequest = new Request('http://test/api/batch-extractions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    })

    const response = fixture.handle(clientRequest)
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    controller.abort()

    expect(executionRequest.signal.aborted).toBe(false)
    release()
    await expect(response).resolves.toMatchObject({ status: 200 })
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

    // A succeeded Extraction with nothing to review is neither reviewed nor
    // awaiting review; the three groups partition the succeeded members.
    const withUnreviewable = {
      ...listed,
      members: [
        ...listed.members,
        {
          ...listed.members[0],
          sourceDocumentId: PENDING,
          latestExtraction: {
            ...listed.members[0].latestExtraction!,
            reviewable: false,
            reviewedAt: null,
          },
        },
      ],
    }
    const progress = batchExtractionProgress(withUnreviewable)
    expect(progress).toMatchObject({ reviewed: 1, unreviewable: 1, needsReview: 0 })
    expect(progress.reviewed + progress.unreviewable + progress.needsReview).toBe(2)
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
