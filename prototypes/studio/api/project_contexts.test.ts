import { describe, expect, it, vi } from 'vitest'
import { createProjectStore } from '../../../packages/db/src/project-store.js'
import {
  projectContextWithDocumentsResponseSchema,
  projectContextListResponseSchema,
} from '../shared/projectContext.contract.js'
import {
  DEMO_PROJECT_ID,
  projectContextFixture,
} from './project_contexts.fixture.js'
import { createGetProjectContexts } from './project_contexts.js'

describe('Project Context routes', () => {
  it('returns no-store list and detail DTOs, and bounds invalid input', async () => {
    const GET = createGetProjectContexts(projectContextFixture())
    const list = await GET(
      new Request('http://test/api/project-contexts?limit=1'),
    )
    expect(list.headers.get('cache-control')).toBe('no-store')
    const listBody = await list.json()
    expect(projectContextListResponseSchema.parse(listBody)).toMatchObject({
      projectContexts: [{ projectContextId: DEMO_PROJECT_ID }],
    })
    const detail = await GET(
      new Request(`http://test/api/project-contexts/${DEMO_PROJECT_ID}`),
    )
    expect(detail.headers.get('cache-control')).toBe('no-store')
    const detailBody = await detail.json()
    expect(
      projectContextWithDocumentsResponseSchema.parse(detailBody),
    ).toMatchObject({
      sourceDocuments: [{ name: 'Beretning_Ellekilde_8_13.pdf' }],
    })
    const invalid = await GET(
      new Request('http://test/api/project-contexts?limit=0'),
    )
    expect(invalid.status).toBe(422)
    expect(invalid.headers.get('cache-control')).toBe('no-store')
    await expect(invalid.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'limit must be an integer from 1 to 50.',
      },
    })
    const invalidId = await GET(
      new Request('http://test/api/project-contexts/NOT-A-UUID'),
    )
    expect(invalidId.status).toBe(422)
    const missing = await GET(
      new Request(
        'http://test/api/project-contexts/00000000-0000-4000-8000-000000000046',
      ),
    )
    expect(missing.status).toBe(404)
  })

  it('bounds persistence failures without exposing their details', async () => {
    const GET = createGetProjectContexts({
      async listProjectContexts() {
        throw new Error('postgresql://secret')
      },
      async getProjectContextWithDocuments() {
        throw new Error('/private/database/path')
      },
    })
    for (const url of [
      'http://test/api/project-contexts',
      `http://test/api/project-contexts/${DEMO_PROJECT_ID}`,
    ]) {
      const response = await GET(new Request(url))
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'persistence_unavailable',
          message: 'Project Context storage is unavailable.',
        },
      })
    }
  })

  it('retries store reads after a failure', async () => {
    const fixture = projectContextFixture()
    const listProjectContexts = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockImplementation((limit) => fixture.listProjectContexts(limit))
    const GET = createGetProjectContexts({ ...fixture, listProjectContexts })

    expect(
      (await GET(new Request('http://test/api/project-contexts'))).status,
    ).toBe(503)
    expect(
      (await GET(new Request('http://test/api/project-contexts'))).status,
    ).toBe(200)
  })

  it('orders database reads by created time and document identity', async () => {
    const createdAt = { asc: vi.fn(), desc: vi.fn() }
    const id = { asc: vi.fn(), desc: vi.fn() }
    const collection = {
      select: vi.fn(),
      orderBy: vi.fn(
        (
          order: Array<
            (fields: { createdAt: typeof createdAt; id: typeof id }) => unknown
          >,
        ) => {
          order.forEach((item) => item({ createdAt, id }))
          return collection
        },
      ),
      where: vi.fn(),
      take: vi.fn(),
      all: vi.fn(async () => []),
      first: vi.fn(async () => ({
        id: DEMO_PROJECT_ID,
        name: 'Project',
        createdAt: new Date(),
      })),
    }
    collection.select.mockReturnValue(collection)
    collection.where.mockReturnValue(collection)
    collection.take.mockReturnValue(collection)
    const store = createProjectStore({
      orm: {
        public: { ProjectContext: collection, SourceDocument: collection },
      },
    } as never)
    await store.listProjectContexts(20)
    await store.getProjectContextWithDocuments(DEMO_PROJECT_ID)
    expect(collection.orderBy).toHaveBeenCalledTimes(2)
    expect(createdAt.desc).toHaveBeenCalledOnce()
    expect(createdAt.asc).toHaveBeenCalledOnce()
    expect(id.desc).toHaveBeenCalledOnce()
    expect(id.asc).toHaveBeenCalledOnce()
    expect(collection.take).toHaveBeenCalledWith(20)
    expect(collection.first).toHaveBeenCalledWith({ id: DEMO_PROJECT_ID })
  })
})
