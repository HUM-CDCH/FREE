import { describe, expect, it, vi } from 'vitest'
import parsedDocument from '../src/assets/parsed_document.v2.json'
import {
  createProjectStore,
  PROJECT_CONTEXT_NAME_LIMIT,
} from '../../../packages/db/src/project-store.js'
import {
  projectContextWithDocumentsResponseSchema,
  projectContextListResponseSchema,
  projectContextNameLimit,
  projectContextResponseSchema,
} from '../shared/projectContext.contract.js'

import {
  DEMO_PROJECT_ID,
  projectContextFixture,
} from './project_contexts.fixture.js'
import {
  createGetProjectContexts,
  createProjectContextWrites,
} from './project_contexts.js'

/** Every Project Context write sends the same JSON name body. */
function write(url: string, method: 'POST' | 'PATCH', name: string): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

describe('Project Context routes', () => {
  it('shares one name limit between the contract and durable storage', () => {
    expect(projectContextNameLimit).toBe(PROJECT_CONTEXT_NAME_LIMIT)
  })

  it('returns no-store list and detail DTOs, and bounds invalid input', async () => {
    const beginSourceSchemaSuggestion = vi.fn()
    const store = {
      ...projectContextFixture(),
      beginSourceSchemaSuggestion,
      completeSourceSchemaSuggestion: vi.fn(),
      failSourceSchemaSuggestion: vi.fn(),
    }
    const GET = createGetProjectContexts(store, async () => ({
      bytes: new TextEncoder().encode(JSON.stringify(parsedDocument)),
      mediaType: 'application/json',
    }))
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
      sourceDocuments: [
        {
          name: 'Beretning_Ellekilde_8_13.pdf',
          pageCount: parsedDocument.page_count,
        },
      ],
    })
    expect(beginSourceSchemaSuggestion).not.toHaveBeenCalled()
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

  it('creates, renames, and permanently deletes one Project Context', async () => {
    const created = {
      projectContextId: '00000000-0000-4000-8000-000000000047',
      name: 'Ellekilde, TAK 1356',
      createdAt: new Date('2026-08-11T09:00:00.000Z'),
    }
    const removed: string[] = []
    const { POST, PATCH, DELETE } = createProjectContextWrites(
      {
        async createProjectContext(name) {
          return { ...created, name }
        },
        async renameProjectContext(projectContextId, name) {
          return projectContextId === DEMO_PROJECT_ID
            ? { ...created, projectContextId, name }
            : null
        },
        async deleteProjectContext(projectContextId) {
          return projectContextId === DEMO_PROJECT_ID
            ? [
                {
                  artifactReference: 'c'.repeat(64),
                  artifactSha256: 'c'.repeat(64),
                },
                // Still pinned elsewhere, so it must survive the deletion.
                {
                  artifactReference: 'd'.repeat(64),
                  artifactSha256: 'd'.repeat(64),
                },
              ]
            : null
        },
        async isPackageReferenced(artifactReference) {
          return artifactReference === 'd'.repeat(64)
        },
      },
      async (descriptor, isReferenced) => {
        expect(await isReferenced()).toBe(false)
        removed.push(descriptor.artifactReference)
      },
    )

    const create = await POST(
      write('http://test/api/project-contexts', 'POST', '  Trimmed  '),
    )
    expect(create.status).toBe(201)
    expect(create.headers.get('cache-control')).toBe('no-store')
    expect(
      projectContextResponseSchema.parse(await create.json()).projectContext,
    ).toMatchObject({ name: 'Trimmed' })

    const rename = await PATCH(
      write(
        `http://test/api/project-contexts/${DEMO_PROJECT_ID}`,
        'PATCH',
        'Renamed',
      ),
    )
    expect(rename.status).toBe(200)
    expect(
      projectContextResponseSchema.parse(await rename.json()).projectContext,
    ).toMatchObject({ projectContextId: DEMO_PROJECT_ID, name: 'Renamed' })

    const remove = await DELETE(
      new Request(`http://test/api/project-contexts/${DEMO_PROJECT_ID}`, {
        method: 'DELETE',
      }),
    )
    expect(remove.status).toBe(204)
    expect(remove.headers.get('cache-control')).toBe('no-store')
    // Removal happens after the relational deletion, and only for the address
    // nothing pins any more.
    expect(removed).toEqual(['c'.repeat(64)])
  })

  it('bounds invalid writes, unknown owners, and persistence failures', async () => {
    const { POST, PATCH, DELETE } = createProjectContextWrites(
      {
        async createProjectContext() {
          throw new Error('postgresql://secret')
        },
        async renameProjectContext() {
          return null
        },
        async deleteProjectContext() {
          return null
        },
        async isPackageReferenced() {
          return false
        },
      },
      async () => {},
    )

    for (const name of ['', '   ', 'x'.repeat(projectContextNameLimit + 1)]) {
      const invalid = await POST(
        write('http://test/api/project-contexts', 'POST', name),
      )
      expect(invalid.status).toBe(422)
      await expect(invalid.json()).resolves.toEqual({
        error: {
          code: 'invalid_request',
          message: `name must be 1 to ${projectContextNameLimit} characters after trimming.`,
        },
      })
    }
    const unnamed = await POST(
      new Request('http://test/api/project-contexts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Not a name' }),
      }),
    )
    expect(unnamed.status).toBe(422)
    expect(
      (
        await PATCH(
          write('http://test/api/project-contexts/NOT-A-UUID', 'PATCH', 'Name'),
        )
      ).status,
    ).toBe(422)
    expect(
      (
        await PATCH(
          write(
            `http://test/api/project-contexts/${DEMO_PROJECT_ID}`,
            'PATCH',
            'Name',
          ),
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await DELETE(
          new Request(`http://test/api/project-contexts/${DEMO_PROJECT_ID}`, {
            method: 'DELETE',
          }),
        )
      ).status,
    ).toBe(404)

    const failed = await POST(
      write('http://test/api/project-contexts', 'POST', 'Ellekilde'),
    )
    expect(failed.status).toBe(503)
    expect(failed.headers.get('cache-control')).toBe('no-store')
    await expect(failed.json()).resolves.toEqual({
      error: {
        code: 'persistence_unavailable',
        message: 'Project Context storage is unavailable.',
      },
    })

    const persistenceFailure = async () => {
      throw new Error('postgresql://secret')
    }
    const writes = createProjectContextWrites(
      {
        createProjectContext: persistenceFailure,
        renameProjectContext: persistenceFailure,
        deleteProjectContext: persistenceFailure,
        async isPackageReferenced() {
          return false
        },
      },
      async () => {},
    )
    for (const response of [
      await writes.PATCH(
        write(
          `http://test/api/project-contexts/${DEMO_PROJECT_ID}`,
          'PATCH',
          'Ellekilde',
        ),
      ),
      await writes.DELETE(
        new Request(`http://test/api/project-contexts/${DEMO_PROJECT_ID}`, {
          method: 'DELETE',
        }),
      ),
    ]) {
      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'persistence_unavailable',
          message: 'Project Context storage is unavailable.',
        },
      })
    }
  })

  it('keeps a stranded retained artifact from failing an applied deletion', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The shipped remover runs: an unusable reference must only be logged.
    const { DELETE } = createProjectContextWrites({
      async createProjectContext() {
        throw new Error('unused')
      },
      async renameProjectContext() {
        return null
      },
      async deleteProjectContext() {
        return [{ artifactReference: 'not-a-reference', artifactSha256: 'x' }]
      },
      async isPackageReferenced() {
        return false
      },
    })

    const response = await DELETE(
      new Request(`http://test/api/project-contexts/${DEMO_PROJECT_ID}`, {
        method: 'DELETE',
      }),
    )

    expect(response.status).toBe(204)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
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
