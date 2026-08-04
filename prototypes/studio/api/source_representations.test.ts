import { describe, expect, it, vi } from 'vitest'
import { parsedDocumentResourceSchema } from '../shared/projectContext.contract.js'
import {
  DEMO_ARTIFACT_REFERENCE,
  DEMO_REPRESENTATION_ID,
  projectContextFixture,
} from './project_contexts.fixture.js'
import { createSourceRepresentationResource } from './source_representations.js'

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
const IMMUTABLE = 'private, max-age=31536000, immutable'

const url = (artifact: string, id = DEMO_REPRESENTATION_ID) =>
  `http://test/api/source-representations/${id}/${artifact}`

const parsedDocument = {
  schema_version: 'parsed_document.v1',
  document: {
    document_id: `sha256:${'a'.repeat(64)}`,
    content_sha256: 'a'.repeat(64),
    source: { kind: 'upload', original_filename: 'report.pdf' },
    created_at: '2026-01-01T00:00:00Z',
    page_count: 2,
  },
  preprocessing: { preprocess_id: 'sha256:secret', config_hash: 'b'.repeat(64) },
  artifacts: { llm_markdown_ref: 'data/documents/aaa/artifacts/markdown.md' },
  parser_runs: [{ parser: 'docling_pdf', status: 'success' }],
  text_views: { llm_markdown: '# Beretning' },
  pages: [
    { page: 1, text: 'Første side' },
    { page: 2, text: 'Anden side' },
  ],
}

/** Stands in for the Parsing Service's retained artifacts. */
function upstream(
  overrides: Partial<Record<string, () => Response | Promise<Response>>> = {},
) {
  const calls: Array<{ url: string; method: string; headers: Headers }> = []
  const fetchArtifact = vi.fn(
    async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const target = String(input)
      const artifact = target.split('/').at(-1) ?? ''
      calls.push({
        url: target,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
      })
      const override = overrides[artifact]
      if (override) return override()
      if (artifact === 'markdown')
        return new Response('# Beretning', {
          headers: {
            'content-type': 'text/markdown; charset=utf-8',
            'content-length': '11',
          },
        })
      if (artifact === 'document') return Response.json(parsedDocument)
      const range = new Headers(init?.headers).get('range')
      if (range === 'bytes=0-3')
        return new Response(PDF_BYTES.slice(0, 4), {
          status: 206,
          headers: {
            'content-type': 'application/pdf',
            'content-range': 'bytes 0-3/8',
            'content-length': '4',
            'accept-ranges': 'bytes',
          },
        })
      if (range === 'bytes=99-')
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'content-range': 'bytes */8', 'content-length': '21' },
        })
      return new Response(init?.method === 'HEAD' ? null : PDF_BYTES, {
        headers: {
          'content-type': 'application/pdf',
          'content-length': '8',
          'accept-ranges': 'bytes',
        },
      })
    },
  )
  return { calls, fetchArtifact }
}

function resource(
  overrides?: Partial<Record<string, () => Response | Promise<Response>>>,
) {
  const { calls, fetchArtifact } = upstream(overrides)
  return {
    calls,
    fetchArtifact,
    handler: createSourceRepresentationResource(
      projectContextFixture(),
      fetchArtifact,
    ),
  }
}

describe('GET|HEAD /api/source-representations/:id/:artifact', () => {
  it('streams the retained PDF with immutable private caching and range support', async () => {
    const { handler, calls } = resource()

    const full = await handler(new Request(url('pdf')))
    expect(full.status).toBe(200)
    expect(full.headers.get('content-type')).toBe('application/pdf')
    expect(full.headers.get('cache-control')).toBe(IMMUTABLE)
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(full.headers.get('etag')).toBeNull()
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(PDF_BYTES)
    expect(calls[0].url).toContain(DEMO_ARTIFACT_REFERENCE)

    const partial = await handler(
      new Request(url('pdf'), { headers: { range: 'bytes=0-3' } }),
    )
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 0-3/8')
    expect((await partial.arrayBuffer()).byteLength).toBe(4)
    expect(calls[1].headers.get('range')).toBe('bytes=0-3')

    const unsatisfiable = await handler(
      new Request(url('pdf'), { headers: { range: 'bytes=99-' } }),
    )
    expect(unsatisfiable.status).toBe(416)
    expect(unsatisfiable.headers.get('content-range')).toBe('bytes */8')
    expect(unsatisfiable.body).toBeNull()
    expect(unsatisfiable.headers.get('content-length')).toBeNull()
  })

  it('answers HEAD with the GET headers and no body', async () => {
    const { handler, calls } = resource()

    for (const artifact of ['pdf', 'markdown', 'parsed-document']) {
      const response = await handler(
        new Request(url(artifact), { method: 'HEAD' }),
      )
      expect(response.status).toBe(200)
      expect(response.body).toBeNull()
      expect(response.headers.get('cache-control')).toBe(IMMUTABLE)
      expect(response.headers.get('content-length')).toBeTruthy()
    }
    expect(calls.map((call) => call.method)).toEqual(['HEAD', 'HEAD', 'GET'])
  })

  it('serves Markdown and an allow-listed parsed document', async () => {
    const { handler } = resource()

    const markdown = await handler(new Request(url('markdown')))
    expect(markdown.headers.get('content-type')).toBe(
      'text/markdown; charset=utf-8',
    )
    await expect(markdown.text()).resolves.toBe('# Beretning')

    const parsed = await handler(new Request(url('parsed-document')))
    expect(parsed.headers.get('content-type')).toContain('application/json')
    expect(parsed.headers.get('cache-control')).toBe(IMMUTABLE)
    const body: unknown = await parsed.json()
    expect(parsedDocumentResourceSchema.parse(body)).toEqual({
      schemaVersion: 'parsed_document.v1',
      pageCount: 2,
      pages: [
        { page: 1, text: 'Første side' },
        { page: 2, text: 'Anden side' },
      ],
    })
    // Storage paths, hashes, and parser diagnostics stay server-side.
    expect(JSON.stringify(body)).not.toMatch(
      /data\/documents|content_sha256|config_hash|docling|preprocess/i,
    )
  })

  it('does not use the parsed document hash as an artifact validator', async () => {
    const { handler, calls } = resource()

    const response = await handler(
      new Request(url('pdf'), { headers: { 'if-none-match': '"not-a-pdf-hash"' } }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(IMMUTABLE)
    expect(response.headers.get('etag')).toBeNull()
    expect(calls).toHaveLength(1)

    const ranged = await handler(
      new Request(url('pdf'), {
        headers: { range: 'bytes=0-3', 'if-range': '"not-a-pdf-hash"' },
      }),
    )

    expect(ranged.status).toBe(200)
    expect(calls[1].headers.get('range')).toBeNull()
    expect(calls[1].headers.get('if-range')).toBeNull()
  })

  it('bounds an unknown representation and a malformed identity', async () => {
    const { handler } = resource()

    const unknown = await handler(
      new Request(url('pdf', '00000000-0000-4000-8000-000000000099')),
    )
    expect(unknown.status).toBe(404)
    await expect(unknown.json()).resolves.toMatchObject({
      error: { code: 'not_found' },
    })

    const malformed = await handler(new Request(url('pdf', 'NOT-A-UUID')))
    expect(malformed.status).toBe(422)
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: 'invalid_request' },
    })
  })

  it.each([
    [
      'a missing retained artifact',
      () => new Response('task not found', { status: 404 }),
    ],
    [
      'an unreachable Parsing Service',
      () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8000')
      },
    ],
    [
      'an unreadable retained artifact',
      () => new Response('traceback: /srv/data/tasks', { status: 500 }),
    ],
  ])('bounds %s without exposing the upstream', async (_case, override) => {
    const { handler } = resource({ source: override })

    const response = await handler(new Request(url('pdf')))

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'source_artifact_unavailable',
        message: 'The retained Source Document artifact is unavailable.',
      },
    })
  })

  it('bounds an unreadable parsed document', async () => {
    const { handler } = resource({
      document: () => Response.json({ schema_version: 'parsed_document.v1' }),
    })

    const response = await handler(new Request(url('parsed-document')))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'source_artifact_unavailable' },
    })
  })

  it('bounds a persistence failure while resolving the representation', async () => {
    const handler = createSourceRepresentationResource(
      {
        async getSourceRepresentation() {
          throw new Error('postgresql://secret@localhost/free')
        },
      },
      upstream().fetchArtifact,
    )

    const response = await handler(new Request(url('pdf')))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'persistence_unavailable',
        message: 'Project Context storage is unavailable.',
      },
    })
  })
})
