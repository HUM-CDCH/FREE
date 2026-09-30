import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResearcherProjectStore, SchemaRevisionRecord } from '../../../packages/db/src/project-store.js'
import type { ModelOperationClient } from './_model_operation.js'
import { createPostGenerateSchema } from './generate_schema.js'

const ACCOUNT = '51000000-0000-4000-8009-000000000001'
const PROJECT = '51000000-0000-4000-8000-000000000001'
const DOCUMENT = '51000000-0000-4000-8001-000000000001'
const SOURCE_REVISION = '51000000-0000-4000-8002-000000000001'
const SCHEMA = '51000000-0000-4000-8003-000000000001'
const SCHEMA_REVISION = '51000000-0000-4000-8004-000000000001'
const OPERATION = '51000000-0000-4000-8009-0000000000f1'
const revision: SchemaRevisionRecord = {
  schemaRevisionId: SCHEMA_REVISION, extractionSchemaId: SCHEMA, revisionNumber: 1, origin: 'researcher-edit',
  schemaTree: { recordDescription: 'One report.', schemaNodes: [] }, createdAt: new Date('2026-08-01T12:00:00.000Z'),
}
type Store = Pick<ResearcherProjectStore, 'researcherAccountId' | 'getSourceRepresentation' | 'getSchemaRevision'>

function store(overrides: Partial<Store> = {}): Store {
  return {
    researcherAccountId: ACCOUNT,
    getSourceRepresentation: vi.fn(async () => ({ artifactReference: 'a'.repeat(64), artifactSha256: 'a'.repeat(64), sourceDocumentId: DOCUMENT })),
    getSchemaRevision: vi.fn(async () => revision),
    ...overrides,
  }
}

/** A client whose enqueued workflow is found again by getWorkflow, and whose listing reports `output` as SUCCESS. */
function operations(output: unknown = { ok: true, template: { _description: 'x' }, raw: '{}', pages: 3, baseSchemaRevisionId: null }) {
  const enqueued: { options: Record<string, unknown>; input: unknown }[] = []
  const client = {
    enqueue: vi.fn(async (options: Record<string, unknown>, input: unknown) => { enqueued.push({ options, input }); return {} as never }),
    getWorkflow: vi.fn(async () => {
      const last = enqueued.at(-1)
      return last ? { workflowName: last.options.workflowName, input: [last.input] } : undefined
    }),
    listWorkflows: vi.fn(async () => [{ workflowID: `suggestion:${OPERATION}`, status: 'SUCCESS', output }]),
    cancelWorkflow: vi.fn(async () => {}),
    deleteWorkflows: vi.fn(async () => {}),
  }
  return { enqueued, client: client as unknown as ModelOperationClient & typeof client }
}

function form(fields: Record<string, string>): Request {
  const body = new FormData()
  for (const [name, value] of Object.entries(fields)) body.append(name, value)
  return new Request('http://local.test/api/generate_schema', { method: 'POST', body })
}
const base = { project_context_id: PROJECT, source_representation_revision_id: SOURCE_REVISION, operation_id: OPERATION, instruction: 'Catalog entries' }

afterEach(() => vi.restoreAllMocks())

describe('POST /api/generate_schema', () => {
  it('answers with what the suggestion did not read of the source', async () => {
    const sourceCoverage = { complete: false as const, sourceCharacters: 50_040, omitted: [{ page: 1, start: 23_000, end: 27_040 }] }
    const { client } = operations({ ok: true, template: { _description: 'x' }, raw: '{}', pages: 3, sourceCoverage, baseSchemaRevisionId: null })
    const response = await createPostGenerateSchema(store(), () => client)(form(base))

    await expect(response.json()).resolves.toEqual({ template: { _description: 'x' }, raw: '{}', pages: 3, sourceCoverage })
  })

  it("starts suggestion:<operation_id> for the owner with the scope attributes, and answers today's body", async () => {
    const { enqueued, client } = operations()
    const response = await createPostGenerateSchema(store(), () => client)(form(base))

    expect(response.status).toBe(200)
    // An outcome recorded before the source declaration existed declares nothing.
    await expect(response.json()).resolves.toEqual({ template: { _description: 'x' }, raw: '{}', pages: 3, sourceCoverage: null })
    expect(enqueued).toEqual([{
      options: {
        queueName: 'studio', workflowName: 'suggestSchema', workflowID: `suggestion:${OPERATION}`, authenticatedUser: ACCOUNT,
        attributes: { projectContextId: PROJECT, sourceDocumentId: DOCUMENT, sourceRepresentationRevisionId: SOURCE_REVISION, extractionSchemaId: null },
      },
      input: {
        operationId: OPERATION, owner: ACCOUNT, projectContextId: PROJECT, sourceRepresentationRevisionId: SOURCE_REVISION,
        extractionSchemaId: null, baseSchemaRevisionId: null, instruction: 'Catalog entries', temperature: null,
      },
    }])
  })

  it('a base names its Extraction Schema and revision; one without the other is 422; a base outside the project is 404', async () => {
    const based = operations()
    const owned = store()
    const response = await createPostGenerateSchema(owned, () => based.client)(form({ ...base, extraction_schema_id: SCHEMA, base_schema_revision_id: SCHEMA_REVISION }))
    expect(response.status).toBe(200)
    expect(owned.getSchemaRevision).toHaveBeenCalledExactlyOnceWith(PROJECT, SCHEMA, SCHEMA_REVISION)
    expect(based.enqueued[0]!.options.attributes).toMatchObject({ extractionSchemaId: SCHEMA })
    expect(based.enqueued[0]!.input).toMatchObject({ extractionSchemaId: SCHEMA, baseSchemaRevisionId: SCHEMA_REVISION })

    const half = operations()
    expect((await createPostGenerateSchema(store(), () => half.client)(form({ ...base, extraction_schema_id: SCHEMA }))).status).toBe(422)
    expect((await createPostGenerateSchema(store(), () => half.client)(form({ ...base, base_schema_revision_id: SCHEMA_REVISION }))).status).toBe(422)
    expect(half.enqueued).toEqual([])

    const foreign = operations()
    const missing = store({ getSchemaRevision: vi.fn(async () => null) })
    expect((await createPostGenerateSchema(missing, () => foreign.client)(form({ ...base, extraction_schema_id: SCHEMA, base_schema_revision_id: SCHEMA_REVISION }))).status).toBe(404)
    expect(foreign.enqueued).toEqual([])
  })

  it('a missing or non-canonical operation_id is 422', async () => {
    const { enqueued, client } = operations()
    const without = Object.fromEntries(Object.entries(base).filter(([name]) => name !== 'operation_id'))
    expect((await createPostGenerateSchema(store(), () => client)(form(without))).status).toBe(422)
    expect((await createPostGenerateSchema(store(), () => client)(form({ ...base, operation_id: OPERATION.toUpperCase() }))).status).toBe(422)
    expect(enqueued).toEqual([])
  })

  it('a typed failure answers its own status, code and message', async () => {
    const { client } = operations({ ok: false, status: 409, code: 'model_key_required', message: 'Studio does not hold the key.' })
    const response = await createPostGenerateSchema(store(), () => client)(form(base))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'model_key_required', message: 'Studio does not hold the key.' } })
  })

  it('a source outside the account is 404 and starts nothing', async () => {
    const { enqueued, client } = operations()
    const response = await createPostGenerateSchema(store({ getSourceRepresentation: vi.fn(async () => null) }), () => client)(form(base))
    expect(response.status).toBe(404)
    expect(enqueued).toEqual([])
  })
})
