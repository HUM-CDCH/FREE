import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ResearcherProjectStore,
  SchemaRevisionRecord,
} from '../../../packages/db/src/project-store.js'
import type { ModelOperationClient } from '../api/_model_operation'
import { createPostEditSchema } from '../api/edit_schema'
import { createPostGenerateSchema } from '../api/generate_schema'
import { GET as healthGet } from '../api/healthz'

const ACCOUNT = '51000000-0000-4000-8009-000000000001'
const PROJECT = '51000000-0000-4000-8000-000000000001'
const SOURCE_REVISION = '51000000-0000-4000-8002-000000000001'
const SCHEMA = '51000000-0000-4000-8003-000000000001'
const SCHEMA_REVISION = '51000000-0000-4000-8004-000000000001'
const DOCUMENT = '51000000-0000-4000-8001-000000000001'
const OPERATION = '51000000-0000-4000-8009-0000000000f1'
const descriptor = {
  artifactReference: 'a'.repeat(64),
  artifactSha256: 'a'.repeat(64),
  sourceDocumentId: DOCUMENT,
}
const revision: SchemaRevisionRecord = {
  schemaRevisionId: SCHEMA_REVISION,
  extractionSchemaId: SCHEMA,
  revisionNumber: 1,
  origin: 'researcher-edit',
  schemaTree: {
    recordDescription: 'One report.',
    schemaNodes: [],
  },
  createdAt: new Date('2026-08-01T12:00:00.000Z'),
}

type ContextStore = Pick<
  ResearcherProjectStore,
  'researcherAccountId' | 'getSourceRepresentation' | 'getSchemaRevision'
>

function contextStore(
  overrides: Partial<ContextStore> = {},
): ContextStore {
  return {
    researcherAccountId: ACCOUNT,
    getSourceRepresentation: vi.fn(async () => descriptor),
    getSchemaRevision: vi.fn(async () => revision),
    ...overrides,
  }
}

function sourceForm(): FormData {
  const form = new FormData()
  form.append('project_context_id', PROJECT)
  form.append('source_representation_revision_id', SOURCE_REVISION)
  return form
}

/** A generation's form: the source identity plus the client-minted operation ID. */
function generateForm(): FormData {
  const form = sourceForm()
  form.append('operation_id', OPERATION)
  return form
}

/** A model-operation client that finds its enqueued workflow again and reports it finished with `output`. */
function operations(output: unknown = { ok: true, template: { title: 'verbatim-string' }, raw: '{"title":"verbatim-string"}', pages: null, baseSchemaRevisionId: null }) {
  let enqueued: { workflowName: string; input: unknown } | undefined
  const client = {
    enqueue: vi.fn(async (options: { workflowName: string }, input: unknown) => { enqueued = { workflowName: options.workflowName, input }; return {} as never }),
    getWorkflow: vi.fn(async () => (enqueued ? { workflowName: enqueued.workflowName, input: [enqueued.input] } : undefined)),
    listWorkflows: vi.fn(async () => [{ workflowID: `suggestion:${OPERATION}`, status: 'SUCCESS', output }]),
    cancelWorkflow: vi.fn(async () => {}),
    deleteWorkflows: vi.fn(async () => {}),
  }
  return client as unknown as ModelOperationClient & typeof client
}

function formRequest(path: string, form: FormData): Request {
  return new Request(`http://local.test/api/${path}`, {
    method: 'POST',
    body: form,
  })
}

function editForm(): FormData {
  const form = sourceForm()
  form.append('extraction_schema_id', SCHEMA)
  form.append('schema_revision_id', SCHEMA_REVISION)
  form.append('instruction', 'Add title')
  form.append('operation_id', OPERATION)
  return form
}

const PROPOSED = { status: 'proposed', fields: {}, additions: [], issues: [] }

afterEach(() => vi.clearAllMocks())

describe('Studio API endpoints', () => {
  it('GET /api/healthz returns ok', async () => {
    const response = healthGet()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('starts a durable Schema Suggestion over the owner-scoped source and answers its result', async () => {
    const store = contextStore()
    const client = operations()
    const response = await createPostGenerateSchema(store, () => client)(formRequest('generate_schema', generateForm()))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      template: { title: 'verbatim-string' },
      raw: '{"title":"verbatim-string"}',
      pages: null,
    })
    expect(store.getSourceRepresentation).toHaveBeenCalledWith(PROJECT, SOURCE_REVISION)
    // The handler never reads the document: the workflow does, outside history.
    expect(client.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workflowName: 'suggestSchema', workflowID: `suggestion:${OPERATION}`, authenticatedUser: ACCOUNT }),
      expect.objectContaining({ owner: ACCOUNT, sourceRepresentationRevisionId: SOURCE_REVISION }),
    )
  })

  it('starts a durable edit proposal over the persisted owner-scoped revision, never browser-authored nodes', async () => {
    const store = contextStore()
    const client = operations({ ok: true, baseSchemaRevisionId: SCHEMA_REVISION, response: PROPOSED })
    const response = await createPostEditSchema(store, () => client)(formRequest('edit_schema', editForm()))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(PROPOSED)
    expect(store.getSourceRepresentation).toHaveBeenCalledWith(PROJECT, SOURCE_REVISION)
    expect(store.getSchemaRevision).toHaveBeenCalledWith(PROJECT, SCHEMA, SCHEMA_REVISION)
    // The handler reads neither the schema tree nor the document: the workflow does, outside history.
    expect(client.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workflowName: 'proposeSchemaEdit', workflowID: `edit:${OPERATION}`, authenticatedUser: ACCOUNT,
        attributes: { projectContextId: PROJECT, extractionSchemaId: SCHEMA, sourceDocumentId: DOCUMENT, sourceRepresentationRevisionId: SOURCE_REVISION },
      }),
      expect.objectContaining({ owner: ACCOUNT, baseSchemaRevisionId: SCHEMA_REVISION, instruction: 'Add title' }),
    )
  })

  it('starts a schema-only edit proposal without inventing a source context', async () => {
    const form = editForm()
    form.delete('source_representation_revision_id')
    const store = contextStore()
    const client = operations({ ok: true, baseSchemaRevisionId: SCHEMA_REVISION, response: PROPOSED })
    const response = await createPostEditSchema(store, () => client)(formRequest('edit_schema', form))

    expect(response.status).toBe(200)
    expect(store.getSourceRepresentation).not.toHaveBeenCalled()
    expect(client.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ attributes: { projectContextId: PROJECT, extractionSchemaId: SCHEMA } }),
      expect.objectContaining({ sourceRepresentationRevisionId: null }),
    )
  })

  it('rejects browser-authored source and schema context', async () => {
    const generation = generateForm()
    generation.append('document_markdown', '# Browser report')
    const generationStore = contextStore()
    const generationClient = operations()
    expect(
      (
        await createPostGenerateSchema(generationStore, () => generationClient)(formRequest('generate_schema', generation))
      ).status,
    ).toBe(400)
    expect(generationStore.getSourceRepresentation).not.toHaveBeenCalled()
    expect(generationClient.enqueue).not.toHaveBeenCalled()

    const editing = editForm()
    editing.append('current_nodes', '[]')
    const editStore = contextStore()
    const editClient = operations()
    expect(
      (
        await createPostEditSchema(editStore, () => editClient)(formRequest('edit_schema', editing))
      ).status,
    ).toBe(400)
    expect(editStore.getSchemaRevision).not.toHaveBeenCalled()
    expect(editClient.enqueue).not.toHaveBeenCalled()
  })

  it('returns 404 for cross-owner and mixed pins before artifact or model access', async () => {
    const missingSource = contextStore({
      getSourceRepresentation: vi.fn(async () => null),
    })
    const missingClient = operations()
    expect(
      (
        await createPostGenerateSchema(missingSource, () => missingClient)(formRequest('generate_schema', generateForm()))
      ).status,
    ).toBe(404)
    expect(missingClient.enqueue).not.toHaveBeenCalled()

    const mixed = contextStore({
      getSchemaRevision: vi.fn(async () => null),
    })
    const mixedClient = operations()
    expect(
      (
        await createPostEditSchema(mixed, () => mixedClient)(formRequest('edit_schema', editForm()))
      ).status,
    ).toBe(404)
    expect(mixedClient.enqueue).not.toHaveBeenCalled()
  })
})
