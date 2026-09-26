import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import type {
  ResearcherProjectStore,
  SchemaRevisionRecord,
} from '../../../packages/db/src/project-store.js'
import {
  generateSchemaWithModel,
  generateSchemaEditJson,
} from '../api/_model'
import type { ModelOperationClient } from '../api/_model_operation'
import { createPostEditSchema } from '../api/edit_schema'
import { createPostGenerateSchema } from '../api/generate_schema'
import { GET as healthGet } from '../api/healthz'

vi.mock('../api/_model', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    generateSchemaWithModel: vi.fn(),
    generateSchemaEditJson: vi.fn(),
  }
})

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

function markdownReader(): Pick<CanonicalPackageStore, 'read'> {
  return {
    read: vi.fn(async () => ({
      bytes: new TextEncoder().encode('# Canonical report'),
      mediaType: 'text/markdown; charset=utf-8',
    })),
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
  return form
}

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
    expect(generateSchemaWithModel).not.toHaveBeenCalled()
  })

  it('edits the persisted owner-scoped revision rather than browser-authored nodes', async () => {
    vi.mocked(generateSchemaEditJson).mockResolvedValue({
      text: '{"fields":{},"additions":[]}',
    })
    const store = contextStore()
    const request = formRequest('edit_schema', editForm())
    const response = await createPostEditSchema(
      store,
      markdownReader(),
    )(request)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: 'proposed',
      fields: {},
      additions: [],
      issues: [],
    })
    expect(store.getSourceRepresentation).toHaveBeenCalledWith(
      PROJECT,
      SOURCE_REVISION,
    )
    expect(store.getSchemaRevision).toHaveBeenCalledWith(
      PROJECT,
      SCHEMA,
      SCHEMA_REVISION,
    )
    expect(generateSchemaEditJson).toHaveBeenCalledOnce()
    expect(vi.mocked(generateSchemaEditJson).mock.calls[0]?.[0]).toEqual({ researcherAccountId: ACCOUNT })
    // The request's signal ends the edit, and with it any wait for a key, when the browser leaves.
    expect(vi.mocked(generateSchemaEditJson).mock.calls[0]?.[3]).toBe(request.signal)
  })

  it('edits a persisted owner-scoped revision without inventing a source context', async () => {
    vi.mocked(generateSchemaEditJson).mockResolvedValue({
      text: '{"fields":{},"additions":[]}',
    })
    const form = editForm()
    form.delete('source_representation_revision_id')
    const store = contextStore()
    const reader = markdownReader()
    const response = await createPostEditSchema(
      store,
      reader,
    )(formRequest('edit_schema', form))

    expect(response.status).toBe(200)
    expect(store.getSchemaRevision).toHaveBeenCalledWith(
      PROJECT,
      SCHEMA,
      SCHEMA_REVISION,
    )
    expect(store.getSourceRepresentation).not.toHaveBeenCalled()
    expect(reader.read).not.toHaveBeenCalled()
    expect(generateSchemaEditJson).toHaveBeenCalledOnce()
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
    expect(
      (
        await createPostEditSchema(
          editStore,
          markdownReader(),
        )(formRequest('edit_schema', editing))
      ).status,
    ).toBe(400)
    expect(editStore.getSchemaRevision).not.toHaveBeenCalled()

    expect(generateSchemaWithModel).not.toHaveBeenCalled()
    expect(generateSchemaEditJson).not.toHaveBeenCalled()
  })

  it('returns 404 for cross-owner and mixed pins before artifact or model access', async () => {
    const reader = markdownReader()
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
    expect(
      (
        await createPostEditSchema(
          mixed,
          reader,
        )(formRequest('edit_schema', editForm()))
      ).status,
    ).toBe(404)
    expect(reader.read).not.toHaveBeenCalled()
    expect(generateSchemaWithModel).not.toHaveBeenCalled()
    expect(generateSchemaEditJson).not.toHaveBeenCalled()
  })
})
