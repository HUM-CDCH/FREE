import { describe, expect, it, vi } from 'vitest'
import type {
  ExtractionSchemaSummary,
  ResearcherProjectStore,
} from '../../../packages/db/src/project-store.js'
import { extractionSchemaListResponseSchema } from '../shared/schemaRevision.contract.js'
import {
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
    )
  })

  it('bounds invalid input, missing schemas, and persistence failures', async () => {
    const missing = createPatchExtractionSchema({
      renameExtractionSchema: vi.fn(async () => null),
    })
    expect((await missing(request({ projectContextId: PROJECT, name: '' }))).status).toBe(422)
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
