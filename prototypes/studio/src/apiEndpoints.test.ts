import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { ApiError } from '../api/_http'
import {
  extractWithModel,
  generateSchemaWithModel,
  generateSchemaEditJson,
  streamChatWithModel,
} from '../api/_model'
import { POST as chatPost } from '../api/chat'
import { POST as editPost } from '../api/edit_schema'
import { POST as extractPost } from '../api/extract'
import { POST as schemaPost } from '../api/generate_schema'
import { GET as healthGet } from '../api/healthz'

vi.mock('../api/_model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/_model')>()
  return {
    ...actual,
    extractWithModel: vi.fn(),
    generateSchemaWithModel: vi.fn(),
    generateSchemaEditJson: vi.fn(),
    streamChatWithModel: vi.fn(),
  }
})

function formRequest(endpoint: 'extract' | 'generate_schema'): Request {
  const form = new FormData()
  form.append('file', new Blob(['%PDF'], { type: 'application/pdf' }), 'report.pdf')
  if (endpoint === 'extract') form.append('template', '{}')
  return new Request(`http://local.test/api/${endpoint}`, { method: 'POST', body: form })
}

afterEach(() => vi.clearAllMocks())

describe('Studio API endpoints', () => {
  it('GET /api/healthz returns ok', async () => {
    const response = healthGet()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('POST /api/extract returns the documented JSON shape', async () => {
    vi.mocked(extractWithModel).mockResolvedValue({
      result: { title: 'Report' },
      raw: '{"title":"Report"}',
      reasoning: null,
      pages: null,
      modelAttribution: { provider: 'ollama', modelId: 'test-model' },
    })

    const response = await extractPost(formRequest('extract'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      result: { title: 'Report' },
      raw: '{"title":"Report"}',
      reasoning: null,
      pages: null,
      modelAttribution: { provider: 'ollama', modelId: 'test-model' },
    })
  })

  it('POST /api/generate_schema returns the documented JSON shape', async () => {
    vi.mocked(generateSchemaWithModel).mockResolvedValue({
      template: { title: 'verbatim-string' },
      raw: '{"template":{"title":"verbatim-string"}}',
      pages: null,
    })

    const response = await schemaPost(formRequest('generate_schema'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      template: { title: 'verbatim-string' },
      raw: '{"template":{"title":"verbatim-string"}}',
      pages: null,
    })
  })

  it('POST /api/chat returns the mocked UI message stream response', async () => {
    vi.mocked(streamChatWithModel).mockResolvedValue(new Response('stream'))
    const messages: UIMessage[] = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }]

    const response = await chatPost(
      new Request('http://local.test/api/chat', {
        method: 'POST',
        body: JSON.stringify({ messages, documentMarkdown: '# Report' }),
        headers: { 'content-type': 'application/json' },
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('stream')
  })

  it('rejects malformed client JSON without model-output repair or invocation', async () => {
    const form = new FormData()
    form.append('document_markdown', '# Report')
    form.append('template', '{broken')
    const response = await extractPost(
      new Request('http://local.test/api/extract', { method: 'POST', body: form }),
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } })
    expect(extractWithModel).not.toHaveBeenCalled()
  })

  it('rejects a File annotations entry before schema generation', async () => {
    const form = new FormData()
    form.append('document_markdown', '# Report')
    form.append('annotations', new File(['[]'], 'annotations.json', { type: 'application/json' }))
    const response = await schemaPost(
      new Request('http://local.test/api/generate_schema', { method: 'POST', body: form }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'invalid_request', message: 'annotations must be text' },
    })
    expect(generateSchemaWithModel).not.toHaveBeenCalled()
  })

  it('keeps schema-edit client parsing strict while preserving null document context', async () => {
    const malformed = new FormData()
    malformed.append('current_nodes', '{broken')
    malformed.append('instruction', 'Add title')
    const invalid = await editPost(
      new Request('http://local.test/api/edit_schema', { method: 'POST', body: malformed }),
    )
    expect(invalid.status).toBe(400)
    expect(generateSchemaEditJson).not.toHaveBeenCalled()

    vi.mocked(generateSchemaEditJson).mockResolvedValue({
      text: '{"fields":{},"additions":[]}',
    })
    const valid = new FormData()
    valid.append('current_nodes', '[]')
    valid.append('instruction', 'No changes')
    const response = await editPost(
      new Request('http://local.test/api/edit_schema', { method: 'POST', body: valid }),
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'proposed', fields: {}, additions: [], issues: [] })
    expect(generateSchemaEditJson).toHaveBeenCalledOnce()
  })

  it('maps buffered and pre-stream failures to the stable envelope', async () => {
    vi.mocked(extractWithModel).mockRejectedValue(
      new ApiError(502, 'model_operation_failed', 'The model operation failed.'),
    )
    const buffered = await extractPost(formRequest('extract'))
    expect(buffered.status).toBe(502)
    await expect(buffered.json()).resolves.toEqual({
      error: { code: 'model_operation_failed', message: 'The model operation failed.' },
    })

    vi.mocked(streamChatWithModel).mockRejectedValue(
      new ApiError(409, 'invalid_model_config', 'The Interaction Route is not configured.'),
    )
    const chat = await chatPost(
      new Request('http://local.test/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [], documentMarkdown: '# Report' }),
      }),
    )
    expect(chat.status).toBe(409)
    await expect(chat.json()).resolves.toMatchObject({ error: { code: 'invalid_model_config' } })
  })
})
