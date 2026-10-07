import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendSchemaRevision,
  getSchemaRevision,
  initializeSchemaRevision,
  listExtractionSchemas,
  listSchemaRevisions,
  renameExtractionSchema,
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
  stabilisedAt: null,
  recordDescription: 'One site record.',
  recordScope: 'records' as const,
  schemaNodes: [{ id: 'node-site', name: 'site', type: 'string' as const }],
}

const definition = {
  recordDescription: revision.recordDescription,
  schemaNodes: revision.schemaNodes,
}

afterEach(() => vi.unstubAllGlobals())

describe('schema revision client', () => {
  it('lists project schemas through the bounded same-origin DTO', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        extractionSchemas: [
          {
            extractionSchemaId: SCHEMA,
            name: 'Places',
            createdAt: revision.createdAt,
            currentRevision: {
              schemaRevisionId: REVISION,
              revisionNumber: 1,
              origin: 'researcher-edit',
              createdAt: revision.createdAt,
            },
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetch)

    await expect(listExtractionSchemas(PROJECT, 10)).resolves.toHaveLength(1)
    expect(fetch).toHaveBeenCalledWith(
      `/api/extraction-schemas?projectContextId=${PROJECT}&limit=10`,
      { signal: undefined, credentials: 'same-origin' },
    )
  })

  it('renames a schema through its project-owned endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        extractionSchema: {
          extractionSchemaId: SCHEMA,
          name: 'Historic places',
          createdAt: revision.createdAt,
        },
      }),
    )
    vi.stubGlobal('fetch', fetch)

    await expect(
      renameExtractionSchema(PROJECT, SCHEMA, 'Historic places'),
    ).resolves.toMatchObject({ name: 'Historic places' })
    expect(fetch).toHaveBeenCalledWith(`/api/extraction-schemas/${SCHEMA}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ projectContextId: PROJECT, name: 'Historic places' }),
      credentials: 'same-origin',
      signal: undefined,
    })
  })

  it('sends a fenced rename\'s expected name; an unfenced rename sends none', async () => {
    const fetch = vi.fn(async () => Response.json({
      extractionSchema: { extractionSchemaId: SCHEMA, name: 'Historic places', createdAt: revision.createdAt },
    }))
    vi.stubGlobal('fetch', fetch)

    await renameExtractionSchema(PROJECT, SCHEMA, 'Historic places', undefined, 'Extraction Schema')
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({
      projectContextId: PROJECT, name: 'Historic places', expectedName: 'Extraction Schema',
    })
  })

  it('initializes, lists, gets, and appends through validated same-origin DTOs', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ revision }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ revisions: [{ ...revision, recordDescription: undefined, schemaNodes: undefined, summary: 'Initial schema' }] }))
      .mockResolvedValueOnce(Response.json({ revision }))
      .mockResolvedValueOnce(Response.json({ revision }, { status: 201 }))
    vi.stubGlobal('fetch', fetch)

    expect((await initializeSchemaRevision(PROJECT, definition)).revisionNumber).toBe(1)
    expect(await listSchemaRevisions(PROJECT, SCHEMA, 20)).toHaveLength(1)
    expect((await getSchemaRevision(PROJECT, SCHEMA, REVISION)).schemaNodes).toEqual(revision.schemaNodes)
    expect((await appendSchemaRevision(PROJECT, SCHEMA, 0, definition)).revisionNumber).toBe(1)
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST' })
    expect(
      fetch.mock.calls.every(([, init]) => init.credentials === 'same-origin'),
    ).toBe(true)
    expect(fetch.mock.calls[3][1]).toMatchObject({ method: 'POST' })
  })

  it('writes a revision’s source declaration only when the write names one', async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json({ revision }, { status: 201 }))
    vi.stubGlobal('fetch', fetch)
    const excerpted = { complete: false as const, sourceCharacters: 900, omitted: [{ page: 2, start: 400, end: 500 }] }

    await initializeSchemaRevision(PROJECT, definition, excerpted)
    await appendSchemaRevision(PROJECT, SCHEMA, 1, definition, null)
    await appendSchemaRevision(PROJECT, SCHEMA, 2, definition)

    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(init.body))
    expect(bodies.map((body) => body.sourceCoverage)).toEqual([excerpted, null, undefined])
    expect(bodies[2]).not.toHaveProperty('sourceCoverage')
  })

  it('writes a record scope only when the write chooses one, and never a caller’s null', async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json({ revision }, { status: 201 }))
    vi.stubGlobal('fetch', fetch)

    await initializeSchemaRevision(PROJECT, definition, undefined, undefined, 'document')
    await initializeSchemaRevision(PROJECT, definition)
    await appendSchemaRevision(PROJECT, SCHEMA, 1, definition, undefined, undefined, 'records')
    // A whole revision passed as the definition keeps its own scope (here null) out of the request.
    await appendSchemaRevision(PROJECT, SCHEMA, 2, { ...revision, recordScope: null } as typeof definition)

    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(init.body))
    expect(bodies.map((body) => body.recordScope)).toEqual(['document', undefined, 'records', undefined])
    expect(bodies[1]).not.toHaveProperty('recordScope')
    expect(bodies[3]).not.toHaveProperty('recordScope')
    expect(Object.keys(bodies[3]).sort()).toEqual(
      ['expectedRevisionNumber', 'extractionSchemaId', 'projectContextId', 'recordDescription', 'schemaNodes'],
    )
  })

  it('preserves the winning head on a conflict', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({
      error: { code: 'revision_conflict', message: 'changed', details: { currentRevision: revision } },
    }, { status: 409 })))

    await expect(appendSchemaRevision(PROJECT, SCHEMA, 0, definition)).rejects.toMatchObject({
      currentRevision: revision,
    })
    await expect(appendSchemaRevision(PROJECT, SCHEMA, 0, definition)).rejects.toBeInstanceOf(SchemaRevisionConflictError)
  })
})
