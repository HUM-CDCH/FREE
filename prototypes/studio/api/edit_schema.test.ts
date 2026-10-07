import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResearcherProjectStore, SchemaRevisionRecord } from '../../../packages/db/src/project-store.js'
import type { ModelOperationClient } from './_model_operation.js'
import { createPostEditSchema } from './edit_schema.js'

const ACCOUNT = '51000000-0000-4000-8009-000000000001'
const PROJECT = '51000000-0000-4000-8000-000000000001'
const DOCUMENT = '51000000-0000-4000-8001-000000000001'
const SOURCE_REVISION = '51000000-0000-4000-8002-000000000001'
const SCHEMA = '51000000-0000-4000-8003-000000000001'
const SCHEMA_REVISION = '51000000-0000-4000-8004-000000000001'
const OPERATION = '51000000-0000-4000-8009-0000000000f1'
const revision: SchemaRevisionRecord = {
  schemaRevisionId: SCHEMA_REVISION, extractionSchemaId: SCHEMA, revisionNumber: 1, origin: 'researcher-edit',
  schemaTree: { recordDescription: 'One report.', schemaNodes: [] }, recordScope: 'document', createdAt: new Date('2026-08-01T12:00:00.000Z'),
  stabilisedAt: null,
}
const PROPOSED = { status: 'proposed', fields: {}, additions: [], issues: [] }
type Store = Pick<ResearcherProjectStore, 'researcherAccountId' | 'getSourceRepresentation' | 'getSchemaRevision'>

function store(overrides: Partial<Store> = {}): Store {
  return {
    researcherAccountId: ACCOUNT,
    getSourceRepresentation: vi.fn(async () => ({ artifactReference: 'a'.repeat(64), artifactSha256: 'a'.repeat(64), sourceDocumentId: DOCUMENT })),
    getSchemaRevision: vi.fn(async () => revision),
    ...overrides,
  }
}

function operations(output: unknown = { ok: true, baseSchemaRevisionId: SCHEMA_REVISION, response: PROPOSED }) {
  const enqueued: { options: Record<string, unknown>; input: unknown }[] = []
  const client = {
    enqueue: vi.fn(async (options: Record<string, unknown>, input: unknown) => { enqueued.push({ options, input }); return {} as never }),
    getWorkflow: vi.fn(async () => {
      const last = enqueued.at(-1)
      return last ? { workflowName: last.options.workflowName, input: [last.input] } : undefined
    }),
    listWorkflows: vi.fn(async () => [{ workflowID: `edit:${OPERATION}`, status: 'SUCCESS', output }]),
    cancelWorkflow: vi.fn(async () => {}),
    deleteWorkflows: vi.fn(async () => {}),
  }
  return { enqueued, client: client as unknown as ModelOperationClient & typeof client }
}

function form(fields: Record<string, string>): Request {
  const body = new FormData()
  for (const [name, value] of Object.entries(fields)) body.append(name, value)
  return new Request('http://local.test/api/edit_schema', { method: 'POST', body })
}
const base = {
  project_context_id: PROJECT, extraction_schema_id: SCHEMA, schema_revision_id: SCHEMA_REVISION,
  operation_id: OPERATION, instruction: 'Rename title to heading',
}

afterEach(() => vi.restoreAllMocks())

describe('POST /api/edit_schema', () => {
  it('starts edit:<operation_id> with the owner, project and schema attributes, and the source keys only for a document-grounded edit', async () => {
    const grounded = operations()
    const owned = store()
    expect((await createPostEditSchema(owned, () => grounded.client)(form({ ...base, source_representation_revision_id: SOURCE_REVISION }))).status).toBe(200)
    expect(owned.getSchemaRevision).toHaveBeenCalledExactlyOnceWith(PROJECT, SCHEMA, SCHEMA_REVISION)
    expect(owned.getSourceRepresentation).toHaveBeenCalledExactlyOnceWith(PROJECT, SOURCE_REVISION)
    expect(grounded.enqueued).toEqual([{
      options: {
        queueName: 'studio', workflowName: 'proposeSchemaEdit', workflowID: `edit:${OPERATION}`, authenticatedUser: ACCOUNT,
        attributes: { projectContextId: PROJECT, extractionSchemaId: SCHEMA, sourceDocumentId: DOCUMENT, sourceRepresentationRevisionId: SOURCE_REVISION },
      },
      input: {
        operationId: OPERATION, owner: ACCOUNT, projectContextId: PROJECT, extractionSchemaId: SCHEMA, baseSchemaRevisionId: SCHEMA_REVISION,
        sourceRepresentationRevisionId: SOURCE_REVISION, instruction: 'Rename title to heading', temperature: null,
      },
    }])

    const schemaOnly = operations()
    const noSource = store()
    expect((await createPostEditSchema(noSource, () => schemaOnly.client)(form(base))).status).toBe(200)
    expect(noSource.getSourceRepresentation).not.toHaveBeenCalled()
    expect(schemaOnly.enqueued[0]!.options.attributes).toEqual({ projectContextId: PROJECT, extractionSchemaId: SCHEMA })
    expect(schemaOnly.enqueued[0]!.input).toMatchObject({ sourceRepresentationRevisionId: null })
  })

  it("answers today's SchemaEditResponse body", async () => {
    const { client } = operations()
    const response = await createPostEditSchema(store(), () => client)(form(base))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(PROPOSED)

    const failure = operations({ ok: false, status: 409, code: 'model_key_required', message: 'Studio does not hold the key.' })
    const failed = await createPostEditSchema(store(), () => failure.client)(form(base))
    expect(failed.status).toBe(409)
    await expect(failed.json()).resolves.toMatchObject({ error: { code: 'model_key_required' } })
  })

  it('a missing operation_id is 422', async () => {
    const { enqueued, client } = operations()
    const without = Object.fromEntries(Object.entries(base).filter(([name]) => name !== 'operation_id'))
    expect((await createPostEditSchema(store(), () => client)(form(without))).status).toBe(422)
    expect((await createPostEditSchema(store(), () => client)(form({ ...base, operation_id: 'not-a-uuid' }))).status).toBe(422)
    expect(enqueued).toEqual([])
  })

  it('a foreign schema revision or source is 404 and starts nothing', async () => {
    const foreignRevision = operations()
    expect((await createPostEditSchema(store({ getSchemaRevision: vi.fn(async () => null) }), () => foreignRevision.client)(form(base))).status).toBe(404)
    expect(foreignRevision.enqueued).toEqual([])

    const foreignSource = operations()
    expect((await createPostEditSchema(store({ getSourceRepresentation: vi.fn(async () => null) }), () => foreignSource.client)(
      form({ ...base, source_representation_revision_id: SOURCE_REVISION }),
    )).status).toBe(404)
    expect(foreignSource.enqueued).toEqual([])
  })
})
