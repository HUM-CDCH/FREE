import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionController } from './useExtraction'
import {
  decodeExtractDone,
  decodeSchemaDone,
  parseDocumentToMarkdown,
  requestExtraction,
  requestSchema,
} from './api'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => vi.unstubAllGlobals())

function readyController(): ExtractionController {
  return {
    state: { status: 'ready', result: { title: 'Report' }, evidence: null },
    canRun: true,
    hasResults: true,
    runExtraction: async () => {},
  }
}

describe('requestExtraction', () => {
  it('posts a blank template object when the UI passes null', async () => {
    let submittedTemplate: FormDataEntryValue | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        submittedTemplate = init.body instanceof FormData ? init.body.get('template') : null
        return Promise.resolve(jsonResponse({ result: {}, evidence: null, reasoning: null, raw: '', pages: null }))
      }),
    )

    await requestExtraction(new Blob(['pdf']), 'report.pdf', null)

    expect(submittedTemplate).toBe('{}')
  })

  it('throws the API detail on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Model endpoint error: boom' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )

    await expect(requestExtraction(new Blob(['pdf']), 'report.pdf', {})).rejects.toThrow(
      'Model endpoint error: boom',
    )
  })
})

describe('requestSchema', () => {
  it('calls the schema generation endpoint', async () => {
    let submittedUrl = ''
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        submittedUrl = url
        return Promise.resolve(jsonResponse({ template: {}, raw: '', pages: null }))
      }),
    )

    await requestSchema(new Blob(['pdf']), 'report.pdf')

    expect(submittedUrl).toBe('/api/generate_schema')
  })
})

describe('parseDocumentToMarkdown', () => {
  it('starts a job, polls until completed, and returns the markdown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/tasks')) {
          return Promise.resolve(jsonResponse({ task_id: 'abc', status: 'pending' }))
        }
        if (url.endsWith('/tasks/abc')) {
          return Promise.resolve(jsonResponse({ status: 'completed' }))
        }
        if (url.endsWith('/tasks/abc/markdown')) {
          return Promise.resolve(new Response('# Doc', { status: 200 }))
        }
        return Promise.reject(new Error(`unexpected ${url}`))
      }),
    )

    await expect(parseDocumentToMarkdown(new Blob(['pdf']), 'report.pdf')).resolves.toEqual({
      taskId: 'abc',
      markdown: '# Doc',
    })
  })

  it('throws the job error when parsing fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/tasks')) {
          return Promise.resolve(jsonResponse({ task_id: 'abc' }))
        }
        if (url.endsWith('/tasks/abc')) {
          return Promise.resolve(jsonResponse({ status: 'failed', error: 'boom' }))
        }
        return Promise.reject(new Error(`unexpected ${url}`))
      }),
    )

    await expect(parseDocumentToMarkdown(new Blob(['pdf']), 'report.pdf')).rejects.toThrow('boom')
  })
})

describe('decoders', () => {
  it('fail loud when response contracts drift', () => {
    expect(() => decodeExtractDone({ raw: '{}' })).toThrow("extract: response missing 'result'")
    expect(() => decodeExtractDone({ result: {}, raw: '{}' })).toThrow("extract: response missing 'evidence'")
    expect(() => decodeSchemaDone({ raw: '{}' })).toThrow("generate_schema: response missing 'template'")
  })
})

describe('ResultsTab markdown', () => {
  it('receives parsed document markdown directly', async () => {
    vi.resetModules()
    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof import('react')>('react')
      return {
        ...actual,
        useState: (initialState: unknown) =>
          initialState === 'review' ? ['markdown', () => undefined] : actual.useState(initialState),
      }
    })
    const { default: ResultsTab } = await import('./ResultsTab')
    const html = renderToStaticMarkup(
      createElement(ResultsTab, {
        controller: readyController(),
        schemaReady: true,
        documentMarkdown: '# Parsed source',
      }),
    )

    vi.doUnmock('react')
    expect(html).toContain('Markdown')
    expect(html).toContain('# Parsed source')
  })
})
