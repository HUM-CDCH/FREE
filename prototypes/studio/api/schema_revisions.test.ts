import { describe, expect, it, vi } from 'vitest'
import type {
  ResearcherProjectStore,
  SchemaRevisionRecord,
} from '../../../packages/db/src/project-store.js'
import {
  schemaRevisionListResponseSchema,
  schemaRevisionResponseSchema,
} from '../shared/schemaRevision.contract.js'
import { createSchemaRevisionHandlers } from './schema_revisions.js'
import policySchema from '../../parsing_service/tests/fixtures/contracts/evidence-policy.schema.json'

const PROJECT = '51000000-0000-4000-8000-000000000001'
const SCHEMA = '51000000-0000-4000-8003-000000000001'
const REVISION_1 = '51000000-0000-4000-8004-000000000001'
const REVISION_2 = '51000000-0000-4000-8004-000000000002'
const nodes = (name: string) => [{ id: `node-${name}`, name, type: 'string' as const }]
const definition = (name: string) => ({
  recordDescription: `One ${name} record.`,
  schemaNodes: nodes(name),
})
const revisions: SchemaRevisionRecord[] = [
  { schemaRevisionId: REVISION_2, extractionSchemaId: SCHEMA, revisionNumber: 2, origin: 'researcher-edit', schemaTree: definition('year'), recordScope: 'records', createdAt: new Date('2026-08-01T12:01:00Z'), stabilisedAt: null },
  { schemaRevisionId: REVISION_1, extractionSchemaId: SCHEMA, revisionNumber: 1, origin: 'suggestion', schemaTree: definition('site'), recordScope: null, createdAt: new Date('2026-08-01T12:00:00Z'), stabilisedAt: null },
]
const EXCERPTED = { complete: false as const, sourceCharacters: 50_040, omitted: [{ page: 1, start: 23_000, end: 27_040 }] }

function store(overrides: Partial<Pick<ResearcherProjectStore, 'initializeSchemaRevision' | 'appendSchemaRevision' | 'listSchemaRevisions' | 'getSchemaRevision'>> = {}) {
  return {
    initializeSchemaRevision: vi.fn(async () => ({ status: 'created' as const, revision: revisions[1] })),
    appendSchemaRevision: vi.fn(async () => ({ status: 'created' as const, revision: revisions[0] })),
    listSchemaRevisions: vi.fn(async () => revisions),
    getSchemaRevision: vi.fn(async () => revisions[1]),
    ...overrides,
  }
}

describe('Schema Revision routes', () => {
  it('transports evidence policy through a revision write and exact revision read', async () => {
    const saved = { ...revisions[0], schemaTree: policySchema }
    const fixture = store({
      appendSchemaRevision: vi.fn(async () => ({ status: 'created' as const, revision: saved })),
      getSchemaRevision: vi.fn(async () => saved),
    })
    const { POST, GET } = createSchemaRevisionHandlers(fixture)
    const response = await POST(new Request('http://test/api/schema-revisions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectContextId: PROJECT, extractionSchemaId: SCHEMA,
        expectedRevisionNumber: 1, ...policySchema }),
    }))
    expect(response.status).toBe(201)
    expect(fixture.appendSchemaRevision).toHaveBeenCalledWith(PROJECT, SCHEMA, 1, policySchema, undefined)
    expect(schemaRevisionResponseSchema.parse(await response.json()).revision.schemaNodes).toEqual(policySchema.schemaNodes)
    const reopened = await GET(new Request(`http://test/api/schema-revisions/${REVISION_2}?projectContextId=${PROJECT}&extractionSchemaId=${SCHEMA}`))
    expect(reopened.status).toBe(200)
    expect(schemaRevisionResponseSchema.parse(await reopened.json()).revision.schemaNodes).toEqual(policySchema.schemaNodes)
  })

  it('creates the initial durable suggestion revision', async () => {
    const fixture = store()
    const { POST } = createSchemaRevisionHandlers(fixture)
    const response = await POST(new Request('http://test/api/schema-revisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectContextId: PROJECT, ...definition('site') }),
    }))

    expect(response.status).toBe(201)
    expect(schemaRevisionResponseSchema.parse(await response.json()).revision).toMatchObject({
      schemaRevisionId: REVISION_1,
      revisionNumber: 1,
      origin: 'suggestion',
    })
    expect(fixture.initializeSchemaRevision).toHaveBeenCalledWith(PROJECT, definition('site'), null)
  })

  it('appends a validated researcher revision and returns its identity and number', async () => {
    const fixture = store()
    const { POST } = createSchemaRevisionHandlers(fixture)
    const response = await POST(new Request('http://test/api/schema-revisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectContextId: PROJECT,
        extractionSchemaId: SCHEMA,
        expectedRevisionNumber: 1,
        ...definition('year'),
      }),
    }))

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(schemaRevisionResponseSchema.parse(await response.json()).revision).toMatchObject({
      schemaRevisionId: REVISION_2,
      revisionNumber: 2,
      schemaNodes: nodes('year'),
    })
    expect(fixture.appendSchemaRevision).toHaveBeenCalledWith(PROJECT, SCHEMA, 1, definition('year'), undefined)
  })

  it('forwards the source declaration a write carries: absent inherits, null records none, a malformed one is refused', async () => {
    const fixture = store()
    const { POST } = createSchemaRevisionHandlers(fixture)
    const post = (body: object) => POST(new Request('http://test/api/schema-revisions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
    const append = { projectContextId: PROJECT, extractionSchemaId: SCHEMA, expectedRevisionNumber: 1, ...definition('year') }

    for (const body of [{ ...append, sourceCoverage: EXCERPTED }, { ...append, sourceCoverage: null }, append])
      expect((await post(body)).status).toBe(201)
    expect((await post({ projectContextId: PROJECT, ...definition('site'), sourceCoverage: EXCERPTED })).status).toBe(201)
    expect((await post({ ...append, sourceCoverage: { complete: false, sourceCharacters: 10, omitted: [] } })).status).toBe(422)

    expect(vi.mocked(fixture.appendSchemaRevision).mock.calls.map((call) => call[4])).toEqual([EXCERPTED, null, undefined])
    expect(fixture.initializeSchemaRevision).toHaveBeenCalledWith(PROJECT, definition('site'), EXCERPTED)
  })

  it('reads every revision with its record scope beside the tree, null for an undeclared legacy one', async () => {
    const { GET } = createSchemaRevisionHandlers(store({ getSchemaRevision: vi.fn(async () => revisions[0]) }))
    const declared = schemaRevisionResponseSchema.parse(await (await GET(new Request(
      `http://test/api/schema-revisions/${REVISION_2}?projectContextId=${PROJECT}&extractionSchemaId=${SCHEMA}`))).json()).revision
    expect(declared).toMatchObject({ ...definition('year'), recordScope: 'records' })
    const legacy = await createSchemaRevisionHandlers(store()).GET(new Request(
      `http://test/api/schema-revisions/${REVISION_1}?projectContextId=${PROJECT}&extractionSchemaId=${SCHEMA}`))
    expect(schemaRevisionResponseSchema.parse(await legacy.json()).revision.recordScope).toBeNull()
    const list = await createSchemaRevisionHandlers(store()).GET(new Request(
      `http://test/api/schema-revisions?projectContextId=${PROJECT}&extractionSchemaId=${SCHEMA}`))
    expect(schemaRevisionListResponseSchema.parse(await list.json()).revisions.map((revision) => [revision.recordScope, revision.summary]))
      .toEqual([['records', 'Saved as Catalog, 1 record description updated, 1 added, 1 removed'], [null, 'Initial schema']])
  })

  it('forwards a written record scope to the store: absent inherits (append) or declares none (initialization)', async () => {
    const fixture = store()
    const { POST } = createSchemaRevisionHandlers(fixture)
    const post = (body: object) => POST(new Request('http://test/api/schema-revisions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
    const append = { projectContextId: PROJECT, extractionSchemaId: SCHEMA, expectedRevisionNumber: 1, ...definition('year') }

    expect((await post({ ...append, recordScope: 'records' })).status).toBe(201)
    expect((await post(append)).status).toBe(201)
    expect((await post({ projectContextId: PROJECT, ...definition('site'), recordScope: 'document' })).status).toBe(201)
    expect((await post({ projectContextId: PROJECT, ...definition('site') })).status).toBe(201)
    expect(vi.mocked(fixture.appendSchemaRevision).mock.calls).toEqual([
      [PROJECT, SCHEMA, 1, definition('year'), undefined, 'records'],
      [PROJECT, SCHEMA, 1, definition('year'), undefined],
    ])
    expect(vi.mocked(fixture.initializeSchemaRevision).mock.calls).toEqual([
      [PROJECT, definition('site'), null, 'document'],
      [PROJECT, definition('site'), null],
    ])
    // The tree never carries the scope: it is stored beside it.
    for (const call of [...vi.mocked(fixture.appendSchemaRevision).mock.calls, ...vi.mocked(fixture.initializeSchemaRevision).mock.calls])
      expect(Object.keys(call.find((argument) => typeof argument === 'object' && argument !== null && 'schemaNodes' in argument)!))
        .toEqual(['recordDescription', 'schemaNodes'])

    // Only the two scopes are a declaration; a written scope cannot un-declare one.
    for (const recordScope of ['article', 'catalog', 'Document', null, ''])
      expect((await post({ ...append, recordScope })).status).toBe(422)
    expect((await post({ projectContextId: PROJECT, ...definition('site'), recordScope: null })).status).toBe(422)
    expect(fixture.appendSchemaRevision).toHaveBeenCalledTimes(2)
  })

  it('returns the winning head for a stale write without exposing persistence details', async () => {
    const { POST } = createSchemaRevisionHandlers(store({
      appendSchemaRevision: vi.fn(async () => ({ status: 'conflict' as const, currentRevision: revisions[0] })),
    }))
    const response = await POST(new Request('http://test/api/schema-revisions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectContextId: PROJECT, extractionSchemaId: SCHEMA, expectedRevisionNumber: 1, ...definition('mine') }),
    }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'revision_conflict', details: { currentRevision: { schemaRevisionId: REVISION_2, revisionNumber: 2 } } },
    })
  })

  it('lists a bounded newest-first timeline with adjacent derived summaries and no trees', async () => {
    const fixture = store()
    const { GET } = createSchemaRevisionHandlers(fixture)
    const response = await GET(new Request(`http://test/api/schema-revisions?projectContextId=${PROJECT}&extractionSchemaId=${SCHEMA}&limit=1`))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(schemaRevisionListResponseSchema.parse(body).revisions).toEqual([
      expect.objectContaining({ schemaRevisionId: REVISION_2, revisionNumber: 2, summary: 'Saved as Catalog, 1 record description updated, 1 added, 1 removed' }),
    ])
    expect(JSON.stringify(body)).not.toContain('schemaNodes')
    expect(fixture.listSchemaRevisions).toHaveBeenCalledWith(PROJECT, SCHEMA, 2)
  })

  it('gets one exact owner-scoped tree and rejects ownership mismatches', async () => {
    const fixture = store()
    const { GET } = createSchemaRevisionHandlers(fixture)
    const response = await GET(new Request(`http://test/api/schema-revisions/${REVISION_1}?projectContextId=${PROJECT}&extractionSchemaId=${SCHEMA}`))
    expect(schemaRevisionResponseSchema.parse(await response.json()).revision.schemaNodes).toEqual(nodes('site'))

    vi.mocked(fixture.getSchemaRevision).mockResolvedValueOnce(null)
    const mismatch = await GET(new Request(`http://test/api/schema-revisions/${REVISION_1}?projectContextId=${PROJECT}&extractionSchemaId=${SCHEMA}`))
    expect(mismatch.status).toBe(404)
    await expect(mismatch.json()).resolves.toMatchObject({ error: { code: 'not_found' } })
  })

  it('keeps cross-owner list, initialization, and append failures indistinguishable from missing data', async () => {
    const missingList = store({
      listSchemaRevisions: vi.fn(async () => null),
    })
    const listResponse = await createSchemaRevisionHandlers(missingList).GET(
      new Request(
        `http://test/api/schema-revisions?projectContextId=${PROJECT}&extractionSchemaId=${SCHEMA}`,
      ),
    )
    expect(listResponse.status).toBe(404)
    await expect(listResponse.json()).resolves.toMatchObject({
      error: { code: 'not_found' },
    })
    expect(missingList.initializeSchemaRevision).not.toHaveBeenCalled()
    expect(missingList.appendSchemaRevision).not.toHaveBeenCalled()

    const missingWrite = store({
      initializeSchemaRevision: vi.fn(async () => null),
      appendSchemaRevision: vi.fn(async () => null),
    })
    const handlers = createSchemaRevisionHandlers(missingWrite)
    const write = (body: unknown) =>
      handlers.POST(
        new Request('http://test/api/schema-revisions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
    expect(
      (
        await write({
          projectContextId: PROJECT,
          extractionSchemaId: SCHEMA,
          expectedRevisionNumber: 1,
          ...definition('cross-owner'),
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await write({
          projectContextId: PROJECT,
          ...definition('cross-owner'),
        })
      ).status,
    ).toBe(404)
    expect(missingWrite.appendSchemaRevision).toHaveBeenCalledOnce()
    expect(missingWrite.initializeSchemaRevision).toHaveBeenCalledOnce()
  })

  it('rejects malformed identities, unbounded limits, unknown fields, and sanitizes store failures', async () => {
    const failing = store({ listSchemaRevisions: vi.fn(async () => { throw new Error('postgresql://secret') }) })
    const { GET, POST } = createSchemaRevisionHandlers(failing)
    expect((await GET(new Request(`http://test/api/schema-revisions?projectContextId=${PROJECT}&extractionSchemaId=${SCHEMA}&limit=51`))).status).toBe(422)
    expect((await POST(new Request('http://test/api/schema-revisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectContextId: PROJECT, extractionSchemaId: SCHEMA, expectedRevisionNumber: 1, ...definition('x'), origin: 'MODEL_EDIT' }) }))).status).toBe(422)
    const unavailable = await GET(new Request(`http://test/api/schema-revisions?projectContextId=${PROJECT}&extractionSchemaId=${SCHEMA}&limit=1`))
    expect(unavailable.status).toBe(503)
    expect(await unavailable.text()).not.toContain('secret')
  })
})
