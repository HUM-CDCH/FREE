import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendSchemaRevision,
  getSchemaRevision,
  initializeSchemaRevision,
  listSchemaRevisions,
  SchemaRevisionConflictError,
} from './schemaRevisions'

const PROJECT = '51000000-0000-4000-8000-000000000001'
const SCHEMA = '51000000-0000-4000-8003-000000000001'
const REVISION = '51000000-0000-4000-8004-000000000001'
const revision = {
  schemaRevisionId: REVISION,
  extractionSchemaId: SCHEMA,
  revisionNumber: 1,
  origin: 'researcher-edit' as const,
  createdAt: '2026-08-01T12:00:00.000Z',
  schemaNodes: [{ id: 'node-site', name: 'site', type: 'string' as const }],
}

afterEach(() => vi.unstubAllGlobals())

describe('schema revision client', () => {
  it('initializes, lists, gets, and appends through validated same-origin DTOs', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ revision }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ revisions: [{ ...revision, schemaNodes: undefined, summary: 'Initial schema' }] }))
      .mockResolvedValueOnce(Response.json({ revision }))
      .mockResolvedValueOnce(Response.json({ revision }, { status: 201 }))
    vi.stubGlobal('fetch', fetch)

    expect((await initializeSchemaRevision(PROJECT, revision.schemaNodes)).revisionNumber).toBe(1)
    expect(await listSchemaRevisions(PROJECT, SCHEMA, 20)).toHaveLength(1)
    expect((await getSchemaRevision(PROJECT, SCHEMA, REVISION)).schemaNodes).toEqual(revision.schemaNodes)
    expect((await appendSchemaRevision(PROJECT, SCHEMA, 0, revision.schemaNodes)).revisionNumber).toBe(1)
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST' })
    expect(fetch.mock.calls[3][1]).toMatchObject({ method: 'POST' })
  })

  it('preserves the winning head on a conflict', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({
      error: { code: 'revision_conflict', message: 'changed', details: { currentRevision: revision } },
    }, { status: 409 })))

    await expect(appendSchemaRevision(PROJECT, SCHEMA, 0, revision.schemaNodes)).rejects.toMatchObject({
      currentRevision: revision,
    })
    await expect(appendSchemaRevision(PROJECT, SCHEMA, 0, revision.schemaNodes)).rejects.toBeInstanceOf(SchemaRevisionConflictError)
  })
})
