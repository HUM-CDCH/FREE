import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import type { CanonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import type {
  ResearcherProjectStore,
  SchemaRevisionRecord,
} from '../../../packages/db/src/project-store.js'
import { ApiError } from '../api/_http'
import {
  generateSchemaWithModel,
  generateSchemaEditJson,
  streamChatWithModel,
} from '../api/_model'
import { createPostChat } from '../api/chat'
import { createPostEditSchema } from '../api/edit_schema'
import { createPostGenerateSchema } from '../api/generate_schema'
import { GET as healthGet } from '../api/healthz'

vi.mock('../api/_model', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    generateSchemaWithModel: vi.fn(),
    generateSchemaEditJson: vi.fn(),
    streamChatWithModel: vi.fn(),
  }
})

const ACCOUNT = '51000000-0000-4000-8009-000000000001'
const PROJECT = '51000000-0000-4000-8000-000000000001'
const SOURCE_REVISION = '51000000-0000-4000-8002-000000000001'
const SCHEMA = '51000000-0000-4000-8003-000000000001'
const SCHEMA_REVISION = '51000000-0000-4000-8004-000000000001'
const descriptor = {
  artifactReference: 'a'.repeat(64),
  artifactSha256: 'a'.repeat(64),
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

function chatRequest(messages: UIMessage[]): Request {
  return new Request('http://local.test/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      projectContextId: PROJECT,
      sourceRepresentationRevisionId: SOURCE_REVISION,
      messages,
    }),
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => vi.clearAllMocks())

describe('Studio API endpoints', () => {
  it('GET /api/healthz returns ok', async () => {
    const response = healthGet()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('generates a schema from owner-scoped canonical Markdown', async () => {
    vi.mocked(generateSchemaWithModel).mockResolvedValue({
      template: { title: 'verbatim-string' },
      raw: '{"template":{"title":"verbatim-string"}}',
      pages: null,
    })
    const store = contextStore()
    const response = await createPostGenerateSchema(
      store,
      markdownReader(),
    )(formRequest('generate_schema', sourceForm()))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      template: { title: 'verbatim-string' },
      raw: '{"template":{"title":"verbatim-string"}}',
      pages: null,
    })
    expect(store.getSourceRepresentation).toHaveBeenCalledWith(
      PROJECT,
      SOURCE_REVISION,
    )
    expect(generateSchemaWithModel).toHaveBeenCalledWith(
      { researcherAccountId: ACCOUNT },
      expect.objectContaining({
        document: {
          file: null,
          pages: null,
          markdown: '# Canonical report',
        },
      }),
    )
  })

  it('streams chat with owner-scoped canonical Markdown', async () => {
    vi.mocked(streamChatWithModel).mockResolvedValue(new Response('stream'))
    const messages: UIMessage[] = [
      {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hi' }],
      },
    ]
    const response = await createPostChat(
      contextStore(),
      markdownReader(),
    )(chatRequest(messages))

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('stream')
    expect(streamChatWithModel).toHaveBeenCalledWith(
      { researcherAccountId: ACCOUNT },
      messages,
      '# Canonical report',
      undefined,
    )
  })

  it('edits the persisted owner-scoped revision rather than browser-authored nodes', async () => {
    vi.mocked(generateSchemaEditJson).mockResolvedValue({
      text: '{"fields":{},"additions":[]}',
    })
    const store = contextStore()
    const response = await createPostEditSchema(
      store,
      markdownReader(),
    )(formRequest('edit_schema', editForm()))

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
    const generation = sourceForm()
    generation.append('document_markdown', '# Browser report')
    const generationStore = contextStore()
    expect(
      (
        await createPostGenerateSchema(
          generationStore,
          markdownReader(),
        )(formRequest('generate_schema', generation))
      ).status,
    ).toBe(400)
    expect(generationStore.getSourceRepresentation).not.toHaveBeenCalled()

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

    const chatStore = contextStore()
    const chat = await createPostChat(chatStore, markdownReader())(
      new Request('http://local.test/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectContextId: PROJECT,
          sourceRepresentationRevisionId: SOURCE_REVISION,
          messages: [],
          documentMarkdown: '# Browser report',
        }),
      }),
    )
    expect(chat.status).toBe(400)
    expect(chatStore.getSourceRepresentation).not.toHaveBeenCalled()
    expect(generateSchemaWithModel).not.toHaveBeenCalled()
    expect(generateSchemaEditJson).not.toHaveBeenCalled()
    expect(streamChatWithModel).not.toHaveBeenCalled()
  })

  it('returns 404 for cross-owner and mixed pins before artifact or model access', async () => {
    const reader = markdownReader()
    const missingSource = contextStore({
      getSourceRepresentation: vi.fn(async () => null),
    })
    expect(
      (
        await createPostGenerateSchema(
          missingSource,
          reader,
        )(formRequest('generate_schema', sourceForm()))
      ).status,
    ).toBe(404)
    expect(
      (
        await createPostChat(
          missingSource,
          reader,
        )(chatRequest([]))
      ).status,
    ).toBe(404)

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
    expect(streamChatWithModel).not.toHaveBeenCalled()
  })

  it('maps pre-stream failures to the stable envelope', async () => {
    vi.mocked(streamChatWithModel).mockRejectedValue(
      new ApiError(
        409,
        'invalid_model_config',
        'The Interaction Route is not configured.',
      ),
    )
    const response = await createPostChat(
      contextStore(),
      markdownReader(),
    )(chatRequest([]))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_model_config' },
    })
  })
})
