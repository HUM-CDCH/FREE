import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import {
  extractWithModel,
  generateSchemaWithModel,
  markdownWithModel,
  streamChatWithModel,
} from '../api/_model'
import { POST as chatPost } from '../api/chat'
import { POST as extractPost } from '../api/extract'
import { POST as schemaPost } from '../api/generate_schema'
import { GET as healthGet } from '../api/healthz'
import { POST as markdownPost } from '../api/markdown'

vi.mock('../api/_model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/_model')>()
  return {
    ...actual,
    extractWithModel: vi.fn(),
    generateSchemaWithModel: vi.fn(),
    markdownWithModel: vi.fn(),
    streamChatWithModel: vi.fn(),
  }
})

function formRequest(endpoint: string): Request {
  const form = new FormData()
  form.append('file', new Blob(['%PDF'], { type: 'application/pdf' }), 'report.pdf')
  form.append('template', '{}')
  return new Request(`http://local.test/api/${endpoint}`, { method: 'POST', body: form })
}

afterEach(() => vi.clearAllMocks())

describe('Vercel API endpoints', () => {
  it('GET /api/healthz returns ok', async () => {
    const response = healthGet()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('POST /api/extract returns the documented JSON shape', async () => {
    vi.mocked(extractWithModel).mockResolvedValue({
      result: { title: 'Report' },
      evidence: { title: { value: 'Report', snippet: 'Report', page: 1 } },
      raw: '{"title":"Report"}',
      reasoning: null,
      pages: null,
    })

    const response = await extractPost(formRequest('extract'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      result: { title: 'Report' },
      evidence: { title: { value: 'Report', snippet: 'Report', page: 1 } },
      raw: '{"title":"Report"}',
      reasoning: null,
      pages: null,
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

  it('POST /api/markdown returns the documented JSON shape', async () => {
    vi.mocked(markdownWithModel).mockResolvedValue({ markdown: '# Report', pages: null })

    const response = await markdownPost(formRequest('markdown'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ markdown: '# Report', pages: null })
  })

  it('POST /api/chat returns the mocked UI message stream response', async () => {
    vi.mocked(streamChatWithModel).mockResolvedValue(new Response('stream'))
    const messages: UIMessage[] = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }]

    const response = await chatPost(
      new Request('http://local.test/api/chat', {
        method: 'POST',
        body: JSON.stringify({ messages }),
        headers: { 'content-type': 'application/json' },
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('stream')
  })
})
