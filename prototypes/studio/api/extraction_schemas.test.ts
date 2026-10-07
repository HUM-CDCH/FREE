import { describe, expect, it, vi } from 'vitest'
import type {
  ExtractionSchemaSummary,
  ResearcherProjectStore,
} from '../../../packages/db/src/project-store.js'
import { extractionSchemaListResponseSchema } from '../shared/schemaRevision.contract.js'
import {
  createDeleteExtractionSchema,
  createGetExtractionSchemas,
  createPatchExtractionSchema,
} from './extraction_schemas.js'

const PROJECT = '51000000-0000-4000-8000-000000000001'
const SCHEMA = '51000000-0000-4000-8003-000000000001'
const REVISION = '51000000-0000-4000-8004-000000000001'
const schemas: ExtractionSchemaSummary[] = [
  {
    extractionSchemaId: SCHEMA,
    name: 'Places',
    createdAt: new Date('2026-08-01T11:00:00Z'),
    currentRevision: {
      schemaRevisionId: REVISION,
      revisionNumber: 2,
      origin: 'researcher-edit',
      createdAt: new Date('2026-08-01T12:00:00Z'),
    },
  },
]

function handler(
  listExtractionSchemas: ResearcherProjectStore['listExtractionSchemas'] = vi.fn(
    async () => schemas,
  ),
) {
  return {
    GET: createGetExtractionSchemas({ listExtractionSchemas }),
    listExtractionSchemas,
  }
}

describe('GET /api/extraction-schemas', () => {
  it('lists bounded project-owned schemas without their trees', async () => {
    const fixture = handler()
    const response = await fixture.GET(
      new Request(
        `http://test/api/extraction-schemas?projectContextId=${PROJECT}&limit=10`,
      ),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(extractionSchemaListResponseSchema.parse(body).extractionSchemas).toEqual([
      expect.objectContaining({
        extractionSchemaId: SCHEMA,
        name: 'Places',
        currentRevision: expect.objectContaining({ revisionNumber: 2 }),
      }),
    ])
    expect(JSON.stringify(body)).not.toContain('schemaTree')
    expect(fixture.listExtractionSchemas).toHaveBeenCalledWith(PROJECT, 10)
  })

  it('validates the project and limit, distinguishes missing projects, and sanitizes failures', async () => {
    const valid = (suffix = '') =>
      new Request(
        `http://test/api/extraction-schemas?projectContextId=${PROJECT}${suffix}`,
      )
    expect((await handler().GET(new Request('http://test/api/extraction-schemas'))).status).toBe(422)
    expect((await handler().GET(valid('&limit=51'))).status).toBe(422)
    expect((await handler(vi.fn(async () => null)).GET(valid())).status).toBe(404)
    const unavailable = await handler(
      vi.fn(async () => {
        throw new Error('postgresql://secret')
      }),
    ).GET(valid())
    expect(unavailable.status).toBe(503)
    expect(await unavailable.text()).not.toContain('secret')
  })
})

describe('PATCH /api/extraction-schemas/:id', () => {
  const request = (body: unknown, id = SCHEMA) =>
    new Request(`http://test/api/extraction-schemas/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('renames one project-owned schema and returns the acknowledged name', async () => {
    const renameExtractionSchema = vi.fn(async (_project, _schema, name) => ({
      extractionSchemaId: SCHEMA,
      name,
      createdAt: schemas[0].createdAt,
    }))
    const PATCH = createPatchExtractionSchema({ renameExtractionSchema })
    const response = await PATCH(
      request({ projectContextId: PROJECT, name: '  Historic places  ' }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({
      extractionSchema: { extractionSchemaId: SCHEMA, name: 'Historic places' },
    })
    expect(renameExtractionSchema).toHaveBeenCalledWith(
      PROJECT,
      SCHEMA,
      'Historic places',
      undefined,
    )
  })

  // The automatic first name is fenced behind the schema's creation name; a rename it no longer applies to answers the
  // schema's name as it stands, with 200: superseded, not failed.
  it('passes a fence to the store and answers the name as it stands when the fence no longer holds', async () => {
    const renameExtractionSchema = vi.fn(async () => ({
      extractionSchemaId: SCHEMA,
      name: 'Custom',
      createdAt: schemas[0].createdAt,
    }))
    const PATCH = createPatchExtractionSchema({ renameExtractionSchema })
    const response = await PATCH(
      request({ projectContextId: PROJECT, name: 'Beretning', expectedName: 'Extraction Schema' }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      extractionSchema: { extractionSchemaId: SCHEMA, name: 'Custom' },
    })
    expect(renameExtractionSchema).toHaveBeenCalledWith(
      PROJECT,
      SCHEMA,
      'Beretning',
      'Extraction Schema',
    )
  })

  it('bounds invalid input, missing schemas, and persistence failures', async () => {
    const missing = createPatchExtractionSchema({
      renameExtractionSchema: vi.fn(async () => null),
    })
    expect((await missing(request({ projectContextId: PROJECT, name: '' }))).status).toBe(422)
    for (const expectedName of ['', '   ', 'x'.repeat(513), 42, null]) {
      const invalid = await missing(request({ projectContextId: PROJECT, name: 'Valid', expectedName }))
      expect(invalid.status, String(expectedName)).toBe(422)
      // The refusal names every field it bounds, the fence included.
      await expect(invalid.json(), String(expectedName)).resolves.toEqual({
        error: {
          code: 'invalid_request',
          message: 'projectContextId and extractionSchemaId must be canonical lowercase UUIDs, and name, and expectedName when given, must be 1 to 512 characters after trimming.',
        },
      })
    }
    expect((await missing(request({ projectContextId: PROJECT, name: 'Valid' }))).status).toBe(404)

    const unavailable = createPatchExtractionSchema({
      renameExtractionSchema: vi.fn(async () => {
        throw new Error('postgresql://secret')
      }),
    })
    const response = await unavailable(
      request({ projectContextId: PROJECT, name: 'Valid' }),
    )
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('secret')
  })
})

describe('DELETE /api/extraction-schemas/:id', () => {
  const request = (
    id = SCHEMA,
    projectContextId: string | null = PROJECT,
    force = false,
  ) =>
    new Request(
      `http://test/api/extraction-schemas/${id}?${new URLSearchParams({
        ...(projectContextId ? { projectContextId } : {}),
        ...(force ? { force: 'true' } : {}),
      })}`,
      { method: 'DELETE' },
    )

  it('deletes one project-owned schema with no Extractions', async () => {
    const deleteExtractionSchema = vi.fn(async () => ({
      status: 'deleted' as const,
    }))
    const DELETE = createDeleteExtractionSchema({ deleteExtractionSchema })
    const response = await DELETE(request())

    expect(response.status).toBe(204)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(deleteExtractionSchema).toHaveBeenCalledWith(PROJECT, SCHEMA, false)
  })

  it('passes force through to the store', async () => {
    const deleteExtractionSchema = vi.fn(async () => ({
      status: 'deleted' as const,
    }))
    const DELETE = createDeleteExtractionSchema({ deleteExtractionSchema })
    await DELETE(request(SCHEMA, PROJECT, true))

    expect(deleteExtractionSchema).toHaveBeenCalledWith(PROJECT, SCHEMA, true)
  })

  it('refuses invalid ids, missing schemas, and schemas with Extractions', async () => {
    const missing = createDeleteExtractionSchema({
      deleteExtractionSchema: vi.fn(async () => null),
    })
    expect((await missing(request('not-a-uuid'))).status).toBe(422)
    expect((await missing(request(SCHEMA, null))).status).toBe(422)
    expect((await missing(request())).status).toBe(404)

    const blocked = createDeleteExtractionSchema({
      deleteExtractionSchema: vi.fn(async () => ({
        status: 'has_extractions' as const,
      })),
    })
    const response = await blocked(request())
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error.code).toBe('extraction_schema_has_extractions')
  })

  it('sanitizes persistence failures', async () => {
    const unavailable = createDeleteExtractionSchema({
      deleteExtractionSchema: vi.fn(async () => {
        throw new Error('postgresql://secret')
      }),
    })
    const response = await unavailable(request())
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('secret')
  })
})
