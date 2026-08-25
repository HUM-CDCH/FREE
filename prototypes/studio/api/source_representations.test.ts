import { describe, expect, it, vi } from 'vitest'
import parsedDocument from '../src/assets/parsed_document.v2.json'
import {
  DEMO_ARTIFACT_REFERENCE,
  DEMO_PROJECT_ID,
  DEMO_REPRESENTATION_ID,
  projectContextFixture,
} from './project_contexts.fixture.js'
import { createSourceRepresentationResource } from './source_representations.js'

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
const PRIVATE_RESPONSE = 'no-store'

const url = (
  artifact: string,
  id = DEMO_REPRESENTATION_ID,
  projectContextId = DEMO_PROJECT_ID,
) =>
  `http://test/api/project-contexts/${projectContextId}/source-representations/${id}/${artifact}`

type Artifact = { bytes: Uint8Array; mediaType: string }

/** Stands in for the Project Context-owned canonical package store. */
function upstream(
  overrides: Partial<Record<string, () => Artifact | Promise<Artifact>>> = {},
) {
  const calls: Array<{
    artifactReference: string
    artifact: string
  }> = []
  const readArtifact = vi.fn(
    async (
      descriptor: { artifactReference: string },
      artifact: 'pdf' | 'markdown' | 'source',
    ) => {
      calls.push({
        artifactReference: descriptor.artifactReference,
        artifact,
      })
      const override = overrides[artifact]
      if (override) return override()
      if (artifact === 'markdown')
        return {
          bytes: new TextEncoder().encode('# Beretning'),
          mediaType: 'text/markdown; charset=utf-8',
        }
      if (artifact === 'source')
        return {
          bytes: new TextEncoder().encode(JSON.stringify(parsedDocument)),
          mediaType: 'application/json',
        }
      return { bytes: PDF_BYTES, mediaType: 'application/pdf' }
    },
  )
  return { calls, readArtifact }
}

function resource(
  overrides?: Partial<Record<string, () => Artifact | Promise<Artifact>>>,
) {
  const { calls, readArtifact } = upstream(overrides)
  return {
    calls,
    readArtifact,
    handler: createSourceRepresentationResource(
      projectContextFixture(),
      readArtifact,
    ),
  }
}

describe('GET|HEAD /api/project-contexts/:projectId/source-representations/:id/:artifact', () => {
  it('streams the retained PDF without cross-session caching and with range support', async () => {
    const { handler, calls } = resource()

    const full = await handler(new Request(url('pdf')))
    expect(full.status).toBe(200)
    expect(full.headers.get('content-type')).toBe('application/pdf')
    expect(full.headers.get('cache-control')).toBe(PRIVATE_RESPONSE)
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(full.headers.get('etag')).toBeNull()
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(PDF_BYTES)
    expect(calls[0].artifactReference).toBe(DEMO_ARTIFACT_REFERENCE)

    const partial = await handler(
      new Request(url('pdf'), { headers: { range: 'bytes=0-3' } }),
    )
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 0-3/8')
    expect((await partial.arrayBuffer()).byteLength).toBe(4)
    expect(calls.at(-1)?.artifact).toBe('pdf')

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

    for (const artifact of ['pdf', 'markdown', 'source']) {
      const response = await handler(
        new Request(url(artifact), { method: 'HEAD' }),
      )
      expect(response.status).toBe(200)
      expect(response.body).toBeNull()
      expect(response.headers.get('cache-control')).toBe(PRIVATE_RESPONSE)
      expect(response.headers.get('content-length')).toBeTruthy()
    }
    expect(calls.map((call) => call.artifact)).toEqual([
      'pdf',
      'markdown',
      'source',
    ])
  })

  it('serves Markdown and an allow-listed parsed document', async () => {
    const { handler } = resource()

    const markdown = await handler(new Request(url('markdown')))
    expect(markdown.headers.get('content-type')).toBe(
      'text/markdown; charset=utf-8',
    )
    await expect(markdown.text()).resolves.toBe('# Beretning')

    const parsed = await handler(new Request(url('source')))
    expect(parsed.headers.get('content-type')).toContain('application/json')
    expect(parsed.headers.get('cache-control')).toBe(PRIVATE_RESPONSE)
    const body: unknown = await parsed.json()
    expect(body).toEqual(parsedDocument)
    expect(JSON.stringify(body)).not.toMatch(/data\/documents|artifactReference/i)
  })

  it('does not use the parsed document hash as an artifact validator', async () => {
    const { handler, calls } = resource()

    const response = await handler(
      new Request(url('pdf'), { headers: { 'if-none-match': '"not-a-pdf-hash"' } }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(PRIVATE_RESPONSE)
    expect(response.headers.get('etag')).toBeNull()
    expect(calls).toHaveLength(1)

    const ranged = await handler(
      new Request(url('pdf'), {
        headers: { range: 'bytes=0-3', 'if-range': '"not-a-pdf-hash"' },
      }),
    )

    expect(ranged.status).toBe(200)
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(PDF_BYTES)
  })

  it('bounds unknown and mixed-owner identities before reading an artifact', async () => {
    const { handler, calls } = resource()

    const unknown = await handler(
      new Request(url('pdf', '00000000-0000-4000-8000-000000000099')),
    )
    expect(unknown.status).toBe(404)
    await expect(unknown.json()).resolves.toMatchObject({
      error: { code: 'not_found' },
    })

    const mixedOwner = await handler(
      new Request(
        url(
          'pdf',
          DEMO_REPRESENTATION_ID,
          '00000000-0000-4000-8000-000000000099',
        ),
      ),
    )
    expect(mixedOwner.status).toBe(404)
    expect(calls).toHaveLength(0)

    const malformed = await handler(new Request(url('pdf', 'NOT-A-UUID')))
    expect(malformed.status).toBe(422)
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: 'invalid_request' },
    })
  })

  it.each([
    [
      'a missing retained artifact',
      () => Promise.reject(new Error('package not found')),
    ],
    [
      'an unreachable Parsing Service',
      () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8000')
      },
    ],
    [
      'an unreadable retained artifact',
      () => Promise.reject(new Error('package integrity check failed')),
    ],
  ])('bounds %s without exposing the upstream', async (_case, override) => {
    const { handler } = resource({ pdf: override })

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
      source: () => ({
        bytes: new TextEncoder().encode(
          JSON.stringify({ schema_version: 'parsed_document.v1' }),
        ),
        mediaType: 'application/json',
      }),
    })

    const response = await handler(new Request(url('source')))

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
      upstream().readArtifact,
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
