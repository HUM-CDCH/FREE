import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { decodeParsedDocument } from 'extraction/parsed-document'
import { createCanonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import { IngestionKeyConflictError } from '../../../packages/db/src/project-store.js'
import {
  createSourceDocumentDeletion,
  createSourceDocumentIngestion,
} from './source_documents.js'

const ids = {
  project: '11111111-1111-4111-8111-111111111111',
  ingestion: '22222222-2222-4222-8222-222222222222',
  source: '33333333-3333-4333-8333-333333333333',
  representation: '44444444-4444-4444-8444-444444444444',
}
const UPLOAD_SHA256 =
  '0716f9264c9fe19f5d7455276107f3ddcc1d3497f63d60689a73558ae8a1bf5e'
const packageDocument = {
  schema_version: 'parsed_document.v2',
  page_count: 12,
  document: { content_sha256: UPLOAD_SHA256 },
  preprocessing: { preprocess_id: 'kei-exp:run-1:gen-1' },
  arbitration: { primary_document_parser: 'kei-exp' },
  parser_runs: [{ parser: 'kei-exp', version: 'docling 2.127.0' }],
}

const sha256 = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex')
const encoder = new TextEncoder()
const decoder = new TextDecoder()

type Overrides = NonNullable<Parameters<typeof createSourceDocumentIngestion>[1]>
type Route = 'submit' | 'status' | 'result' | 'page'
type ParserOptions = {
  /** Status bodies in order; the last one repeats. */
  statuses?: string[]
  /** The hash kei-exp records for the upload; defaults to the upload's own. */
  recordedSha256?: string
  /** The page source kei-exp records; defaults to the one submitted. */
  recordedPageSource?: string
  manifest?: Record<string, unknown>
  respond?: (
    route: Route,
    fallback: () => Response,
    init?: RequestInit,
  ) => Response | Promise<Response>
}

function keiPage() {
  return {
    generation: 'gen-1',
    page: 1,
    size_pt: [612, 792],
    units: [],
    segments: [
      {
        text: 'Grav 8',
        html: null,
        markdown: 'Grav 8',
        label: 'text',
        confidence: null,
        status: 'ok',
        unit: 0,
        crop: null,
        bbox_px: null,
        bbox_pt: [36, 36, 100, 54],
        extent: 'input',
      },
    ],
    markdown: 'Grav 8',
    complete: true,
    warnings: [],
  }
}

function keiResult(sourceSha256: string, overrides: Record<string, unknown> = {}) {
  const page = encoder.encode(JSON.stringify(keiPage()))
  const manifest = {
    result_version: 4,
    generation: 'gen-1',
    digest: 'digest',
    fingerprint: 'fingerprint',
    recipe: {
      source_sha256: sourceSha256,
      transcriber: 'native',
      model: null,
      versions: { docling: '2.127.0', 'surya-ocr': '0.22.1' },
    },
    source_name: 'report.pdf',
    page_count: 1,
    effective: {},
    started: '2026-09-22T12:03:13.269538+00:00',
    seconds: 2.5,
    status: 'success',
    incomplete: null,
    pages: { '1': { sha256: sha256(page), complete: true } },
    tokens: { input: 0, output: 0 },
    ...overrides,
  }
  return { manifest, page }
}

/** kei-exp's HTTP contract as FREE drives it, over an in-memory run table. */
function parser(fetcher: ReturnType<typeof vi.fn>, options: ParserOptions = {}) {
  const runs = new Map<string, { sha256: string; statuses: string[] }>()
  const respond =
    options.respond ?? ((_route: Route, fallback: () => Response) => fallback())
  fetcher.mockImplementation(
    async (input: string | URL | Request, init?: RequestInit) => {
      const { pathname } = new URL(String(input))
      if (pathname === '/api/runs' && init?.method === 'POST') {
        const pdf = (init.body as FormData).get('pdf') as File
        const recorded =
          options.recordedSha256 ??
          sha256(new Uint8Array(await pdf.arrayBuffer()))
        const id = `run-${runs.size + 1}`
        runs.set(id, {
          sha256: recorded,
          statuses: [...(options.statuses ?? ['done'])],
        })
        return respond(
          'submit',
          () =>
            Response.json(
              {
                id,
                status: 'queued',
                params: {
                  source_sha256: recorded,
                  page_source: options.recordedPageSource ?? (init.body as FormData).get('page_source'),
                },
                page_count: 1,
              },
              { status: 202 },
            ),
          init,
        )
      }
      const match = /^\/api\/runs\/([^/]+)(?:\/(result|pages\/1))?$/.exec(
        pathname,
      )
      const run = match ? runs.get(match[1]) : undefined
      if (!match || !run) return new Response('no such run', { status: 404 })
      if (match[2] === undefined)
        return respond(
          'status',
          () => {
            const status =
              run.statuses.length > 1 ? run.statuses.shift() : run.statuses[0]
            return Response.json({
              id: match[1],
              status,
              error:
                status === 'failed'
                  ? 'docling-parse PDFium C:\\private\\input.pdf ' + 'a'.repeat(64)
                  : null,
            })
          },
          init,
        )
      const { manifest, page } = keiResult(run.sha256, options.manifest)
      if (match[2] === 'result')
        return respond('result', () => Response.json(manifest), init)
      return respond(
        'page',
        () =>
          new Response(page, {
            headers: { 'content-type': 'application/json' },
          }),
        init,
      )
    },
  )
}

function request(
  projectContextId = ids.project,
  fields: Array<[string, string | File]> = [
    [
      'file',
      new File(['%PDF-1.7\n'], 'report.pdf', { type: 'application/pdf' }),
    ],
    ['ingestionKey', ids.ingestion],
  ],
) {
  const form = new FormData()
  for (const [key, value] of fields) form.append(key, value)
  return new Request(
    `http://test/api/project-contexts/${projectContextId}/source-documents`,
    { method: 'POST', body: form },
  )
}

function stalledBody(signal: AbortSignal | null | undefined): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        const abort = () =>
          controller.error(signal?.reason ?? new Error('aborted'))
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  )
}

function dependencies(
  overrides: Overrides = {},
  parserOptions: ParserOptions = {},
) {
  const fetcher = vi.fn()
  parser(fetcher, parserOptions)
  const store = {
    getProjectContextWithDocuments: vi.fn().mockResolvedValue({
      projectContext: {},
      sourceDocuments: [],
    }),
    ingestSourceDocument: vi.fn().mockResolvedValue({
      sourceDocumentId: ids.source,
      name: 'report.pdf',
      createdAt: new Date('2026-08-12T10:00:00.000Z'),
      sourceRepresentationId: ids.representation,
      revisionNumber: 1,
      descriptor: {
        artifactReference: 'a'.repeat(64),
        artifactSha256: 'a'.repeat(64),
      },
    }),
    discardCanonicalPackage: vi.fn().mockResolvedValue(undefined),
  }
  const packageStore = {
    save: vi.fn().mockResolvedValue({
      artifactReference: 'a'.repeat(64),
      artifactSha256: 'a'.repeat(64),
      document: packageDocument,
      published: true,
    }),
    available: vi.fn().mockResolvedValue(true),
  }
  return {
    fetcher,
    store,
    packageStore,
    handler: createSourceDocumentIngestion(store, {
      fetcher,
      packageStore,
      parsingServiceBase: 'http://parser.test',
      sleep: async () => {},
      ...overrides,
    }),
  }
}

function requestedPaths(fetcher: ReturnType<typeof vi.fn>): string[] {
  return fetcher.mock.calls.map((call) => new URL(String(call[0])).pathname)
}

describe('Source Document deletion', () => {
  it('delegates authorized reference-safe deletion to the researcher store', async () => {
    const deleteSourceDocument = vi.fn().mockResolvedValue(true)
    const DELETE = createSourceDocumentDeletion({ deleteSourceDocument })

    const response = await DELETE(
      new Request(
        `http://test/api/project-contexts/${ids.project}/source-documents/${ids.source}`,
        { method: 'DELETE' },
      ),
    )

    expect(response.status).toBe(204)
    expect(deleteSourceDocument).toHaveBeenCalledWith(ids.project, ids.source)
  })

  it('uses the existing not-found shape for a missing or cross-owner document', async () => {
    const DELETE = createSourceDocumentDeletion({
      deleteSourceDocument: vi.fn().mockResolvedValue(false),
    })

    const response = await DELETE(
      new Request(
        `http://test/api/project-contexts/${ids.project}/source-documents/${ids.source}`,
        { method: 'DELETE' },
      ),
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'not_found' },
    })
  })
})

describe('POST /api/project-contexts/:id/source-documents', () => {
  it('rejects malformed multipart input before parsing', async () => {
    const { handler, fetcher } = dependencies()
    const invalid = await handler(
      new Request(
        'http://test/api/project-contexts/not-a-uuid/source-documents',
        {
          method: 'POST',
          body: JSON.stringify({}),
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    expect(invalid.status).toBe(422)
    expect(fetcher).not.toHaveBeenCalled()

    const inaccessible = dependencies()
    inaccessible.store.getProjectContextWithDocuments.mockResolvedValueOnce(null)
    const inaccessibleResponse = await inaccessible.handler(request())
    expect(inaccessibleResponse.status).toBe(404)
    expect(inaccessible.fetcher).not.toHaveBeenCalled()

    const missingFile = await handler(
      request(ids.project, [['ingestionKey', ids.ingestion]]),
    )
    expect(missingFile.status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()

    const wrongMime = await handler(
      request(ids.project, [
        ['file', new File(['%PDF-'], 'report.pdf', { type: 'text/plain' })],
        ['ingestionKey', ids.ingestion],
      ]),
    )
    expect(wrongMime.status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()

    const oversized = await handler(
      request(ids.project, [
        [
          'file',
          new File([new Uint8Array(100 * 1024 * 1024 + 1)], 'large.pdf', {
            type: 'application/pdf',
          }),
        ],
        ['ingestionKey', ids.ingestion],
      ]),
    )
    expect(oversized.status).toBe(413)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('ingests a scanned catalogue larger than 50 MiB without truncating it', async () => {
    const { handler, fetcher, packageStore, store } = dependencies()
    const bytes = new Uint8Array(65 * 1024 * 1024)
    bytes.set(encoder.encode('%PDF-1.7\n'))
    const contentSha256 = sha256(bytes)
    packageStore.save.mockResolvedValueOnce({
      artifactReference: 'a'.repeat(64),
      artifactSha256: 'a'.repeat(64),
      document: { ...packageDocument, document: { content_sha256: contentSha256 } },
      published: true,
    })
    const response = await handler(request(ids.project, [
      ['file', new File([bytes], 'catalogue.pdf', { type: 'application/pdf' })],
      ['ingestionKey', ids.ingestion],
    ]))
    expect(response.status).toBe(201)
    const uploaded = (fetcher.mock.calls[0][1].body as FormData).get('pdf') as File
    expect(uploaded.size).toBe(bytes.length)
    expect(store.ingestSourceDocument).toHaveBeenCalledWith(ids.project,
      expect.objectContaining({ contentSha256 }))
  })

  it('submits, polls, fetches the accepted result, and persists one sanitized PDF', async () => {
    const { handler, fetcher, store } = dependencies()
    const response = await handler(
      request(ids.project, [
        [
          'file',
          new File(['%PDF-1.7\n'], 'C:\\unsafe\\report draft.pdf', {
            type: 'application/pdf',
          }),
        ],
        ['ingestionKey', ids.ingestion],
      ]),
    )
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({
      sourceDocumentId: ids.source,
      sourceRepresentationId: ids.representation,
      revisionNumber: 1,
      pageCount: 12,
    })
    expect(store.ingestSourceDocument).toHaveBeenCalledWith(
      ids.project,
      expect.objectContaining({
        ingestionKey: ids.ingestion,
        originalName: 'report draft.pdf',
        contractVersion: 'parsed_document.v2',
        preprocessId: 'kei-exp:run-1:gen-1',
        parserName: 'kei-exp',
        parserVersion: 'docling 2.127.0',
      }),
    )
    expect(requestedPaths(fetcher)).toEqual([
      '/api/runs',
      '/api/runs/run-1',
      '/api/runs/run-1/result',
      '/api/runs/run-1/pages/1',
    ])
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('http://parser.test/api/runs')
    const upload = fetcher.mock.calls[0]?.[1]?.body as FormData
    expect((upload.get('pdf') as File).name).toBe('report draft.pdf')
    expect(Object.fromEntries([...upload.entries()].filter(([key]) => key !== 'pdf'))).toEqual({
      model: 'surya',
      debug: 'false',
      cut: 'auto',
      page_source: 'pdf',
    })
  })

  it('parses scanned two-page spreads as book pages when the researcher chooses that layout', async () => {
    const { handler, fetcher } = dependencies()
    const response = await handler(
      request(ids.project, [
        ['file', new File(['%PDF-1.7\n'], 'catalogue.pdf', { type: 'application/pdf' })],
        ['ingestionKey', ids.ingestion],
        ['layout', 'spreads'],
      ]),
    )
    expect(response.status).toBe(201)
    const upload = fetcher.mock.calls[0]?.[1]?.body as FormData
    expect(upload.get('page_source')).toBe('ingest')
  })

  it('refuses an unknown page layout before parsing', async () => {
    const { handler, fetcher } = dependencies()
    const response = await handler(
      request(ids.project, [
        ['file', new File(['%PDF-1.7\n'], 'catalogue.pdf', { type: 'application/pdf' })],
        ['ingestionKey', ids.ingestion],
        ['layout', 'triptych'],
      ]),
    )
    expect(response.status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('refuses a run that recorded another page layout than the one requested', async () => {
    const { handler, store } = dependencies({}, { recordedPageSource: 'pdf' })
    const response = await handler(
      request(ids.project, [
        ['file', new File(['%PDF-1.7\n'], 'catalogue.pdf', { type: 'application/pdf' })],
        ['ingestionKey', ids.ingestion],
        ['layout', 'spreads'],
      ]),
    )
    expect(response.status).toBe(502)
    expect(store.ingestSourceDocument).not.toHaveBeenCalled()
  })

  it('polls about once a second until the run is done', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const { handler, fetcher } = dependencies(
      { sleep },
      { statuses: ['queued', 'running', 'running', 'done'] },
    )
    expect((await handler(request())).status).toBe(201)
    expect(requestedPaths(fetcher).filter((path) => path === '/api/runs/run-1')).toHaveLength(4)
    expect(sleep.mock.calls).toEqual([[1000], [1000], [1000]])
  })

  it('keeps polling through a transient 503 or 429 on the status read', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    let polls = 0
    const { handler, fetcher, store } = dependencies(
      { sleep },
      {
        statuses: ['running', 'done'],
        respond: (route, fallback) => {
          if (route !== 'status') return fallback()
          polls += 1
          if (polls === 1)
            return new Response('the run store is unavailable', {
              status: 503,
              headers: { 'retry-after': '2' },
            })
          if (polls === 2) return new Response('queue full', { status: 429 })
          return fallback()
        },
      },
    )
    expect((await handler(request())).status).toBe(201)
    expect(requestedPaths(fetcher).filter((path) => path === '/api/runs/run-1')).toHaveLength(4)
    expect(sleep.mock.calls).toEqual([[2000], [1000], [1000]])
    expect(store.ingestSourceDocument).toHaveBeenCalledOnce()

    const exhausted = dependencies(
      { timeoutMs: 0 },
      {
        respond: (route, fallback) =>
          route === 'status'
            ? new Response('the run store is unavailable', { status: 503 })
            : fallback(),
      },
    )
    expect((await exhausted.handler(request())).status).toBe(504)
    expect(exhausted.packageStore.save).not.toHaveBeenCalled()
  })

  it('keeps polling when the status read cannot reach kei-exp at all', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    let polls = 0
    const { handler, fetcher, store } = dependencies(
      { sleep },
      {
        statuses: ['running', 'done'],
        respond: (route, fallback) => {
          if (route !== 'status') return fallback()
          polls += 1
          return polls <= 2
            ? Promise.reject(new TypeError('fetch failed: ECONNREFUSED'))
            : fallback()
        },
      },
    )
    expect((await handler(request())).status).toBe(201)
    expect(requestedPaths(fetcher).filter((path) => path === '/api/runs/run-1')).toHaveLength(4)
    expect(sleep.mock.calls).toEqual([[1000], [1000], [1000]])
    expect(store.ingestSourceDocument).toHaveBeenCalledOnce()

    const unreachable = dependencies(
      { timeoutMs: 0 },
      {
        respond: (route, fallback) =>
          route === 'status'
            ? Promise.reject(new TypeError('fetch failed: ECONNREFUSED'))
            : fallback(),
      },
    )
    expect((await unreachable.handler(request())).status).toBe(504)
    expect(unreachable.packageStore.save).not.toHaveBeenCalled()

    // Submission and artifact fetches still fail fast.
    for (const route of ['submit', 'result', 'page'] as const) {
      const failing = dependencies(
        {},
        {
          respond: (candidate, fallback) =>
            candidate === route
              ? Promise.reject(new TypeError('fetch failed: ECONNRESET'))
              : fallback(),
        },
      )
      const response = await failing.handler(request())
      expect(response.status).toBe(502)
      await expect(response.json()).resolves.toMatchObject({
        error: { message: 'The Parsing Service is unavailable.' },
      })
      expect(failing.packageStore.save).not.toHaveBeenCalled()
    }
  })

  it('packages the translated document with the upload itself and retains it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'free-kei-exp-'))
    try {
      const packageStore = createCanonicalPackageStore(root)
      const { handler, store } = dependencies({ packageStore, now: () => Date.parse('2026-09-22T13:00:00Z') })
      const response = await handler(request())
      expect(response.status).toBe(201)
      await expect(response.json()).resolves.toMatchObject({ pageCount: 1 })
      const input = store.ingestSourceDocument.mock.calls[0][1]
      expect(input).toMatchObject({
        contentSha256: UPLOAD_SHA256,
        preprocessId: 'kei-exp:run-1:gen-1',
        parserName: 'kei-exp',
        parserVersion: 'docling 2.127.0',
      })
      const descriptor = {
        artifactReference: input.artifactReference,
        artifactSha256: input.artifactSha256,
      }
      expect(decoder.decode((await packageStore.read(descriptor, 'pdf')).bytes)).toBe('%PDF-1.7\n')
      expect(decoder.decode((await packageStore.read(descriptor, 'markdown')).bytes)).toBe('Grav 8\n')
      const document = decodeParsedDocument(
        JSON.parse(decoder.decode((await packageStore.read(descriptor, 'source')).bytes)),
      )
      expect(document.document).toMatchObject({
        document_id: 'run-1',
        content_sha256: UPLOAD_SHA256,
        created_at: '2026-09-22T13:00:00.000Z',
        source: { original_filename: 'report.pdf', byte_size: 9 },
      })
      expect(document.content_stream).toEqual([
        {
          kind: 'paragraph',
          block_id: 'b_p1_s0',
          page_number: 1,
          parser: 'kei-exp',
          bbox: { x0: 36, y0: 36, x1: 100, y1: 54 },
          markdown_span: { start: 0, end: 6 },
          text: 'Grav 8',
        },
      ])
      expect(document.evidence_index.anchors[0].producer_observations[0].producer_ref).toBe('kei-exp:native:page-1')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts exactly 180 Unicode scalars and rejects 181 before parsing or persistence', async () => {
    const accepted = dependencies()
    const acceptedName = `${'😀'.repeat(176)}.pdf`
    expect(Array.from(acceptedName)).toHaveLength(180)
    expect(
      (
        await accepted.handler(
          request(ids.project, [
            [
              'file',
              new File(['%PDF-1.7\n'], acceptedName, {
                type: 'application/pdf',
              }),
            ],
            ['ingestionKey', ids.ingestion],
          ]),
        )
      ).status,
    ).toBe(201)
    expect(accepted.store.ingestSourceDocument).toHaveBeenCalledOnce()

    const rejected = dependencies()
    const rejectedName = `${'😀'.repeat(177)}.pdf`
    expect(Array.from(rejectedName)).toHaveLength(181)
    const response = await rejected.handler(
      request(ids.project, [
        [
          'file',
          new File(['%PDF-1.7\n'], rejectedName, {
            type: 'application/pdf',
          }),
        ],
        ['ingestionKey', ids.ingestion],
      ]),
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message:
          'The Source Document filename must contain at most 180 Unicode characters.',
      },
    })
    expect(rejected.fetcher).not.toHaveBeenCalled()
    expect(rejected.packageStore.save).not.toHaveBeenCalled()
    expect(rejected.store.ingestSourceDocument).not.toHaveBeenCalled()
  })

  it('prefers the runtime kei-exp address and model', async () => {
    const { fetcher, store, packageStore } = dependencies()
    vi.stubEnv('KEI_EXP_URL', 'http://runtime-parser.test')
    vi.stubEnv('KEI_EXP_MODEL', 'granite')
    try {
      const handler = createSourceDocumentIngestion(store, {
        fetcher,
        packageStore,
        sleep: async () => {},
      })
      expect((await handler(request())).status).toBe(201)
      expect(String(fetcher.mock.calls[0]?.[0])).toBe(
        'http://runtime-parser.test/api/runs',
      )
      expect((fetcher.mock.calls[0]?.[1]?.body as FormData).get('model')).toBe('granite')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('returns the durable store result when the same request is replayed', async () => {
    const { handler, store } = dependencies()

    const first = await handler(request())
    const replay = await handler(request())

    expect(first.status).toBe(201)
    expect(replay.status).toBe(201)
    await expect(replay.json()).resolves.toMatchObject({
      sourceDocumentId: ids.source,
      sourceRepresentationId: ids.representation,
      revisionNumber: 1,
    })
    expect(store.ingestSourceDocument).toHaveBeenCalledTimes(2)
  })

  it('returns one durable identity for concurrent same-byte requests', async () => {
    const { handler, store } = dependencies()

    const [first, second] = await Promise.all([
      handler(request()),
      handler(
        request(ids.project, [
          [
            'file',
            new File(['%PDF-1.7\n'], 'renamed.pdf', {
              type: 'application/pdf',
            }),
          ],
          [
            'ingestionKey',
            '22222222-2222-4222-8222-222222222223',
          ],
        ]),
      ),
    ])

    expect([first.status, second.status]).toEqual([201, 201])
    const bodies = await Promise.all([first.json(), second.json()])
    expect(bodies[1]).toMatchObject(bodies[0] as Record<string, unknown>)
    expect(store.ingestSourceDocument).toHaveBeenCalledTimes(2)
  })

  it('returns the durable winner and cleans a newly published losing package', async () => {
    const { handler, store, packageStore } = dependencies()
    const winner = {
      artifactReference: 'b'.repeat(64),
      artifactSha256: 'b'.repeat(64),
    }
    store.ingestSourceDocument.mockImplementationOnce(
      async (
        _projectContextId: string,
        input: {
          ensureRetained: (descriptor: typeof winner) => Promise<void>
        },
      ) => {
        await input.ensureRetained(winner)
        return {
          sourceDocumentId: ids.source,
          name: 'report.pdf',
          createdAt: new Date('2026-08-12T10:00:00.000Z'),
          sourceRepresentationId: ids.representation,
          revisionNumber: 1,
          descriptor: winner,
        }
      },
    )

    const response = await handler(request())

    expect(response.status).toBe(201)
    expect(packageStore.available).toHaveBeenCalledWith(winner)
    expect(store.discardCanonicalPackage).toHaveBeenCalledOnce()
    expect(await response.json()).not.toHaveProperty('descriptor')
  })

  it('rejects a key reused for different content and cleans its new package', async () => {
    const { handler, store } = dependencies()
    store.ingestSourceDocument.mockRejectedValueOnce(
      new IngestionKeyConflictError(),
    )

    const response = await handler(request())

    expect(response.status).toBe(409)
    expect(store.discardCanonicalPackage).toHaveBeenCalledOnce()
  })

  it('does not publish or persist when the run fails, is cancelled, or times out', async () => {
    const failed = dependencies({}, { statuses: ['running', 'failed'] })
    const failedResponse = await failed.handler(request())
    expect(failedResponse.status).toBe(422)
    const failedBody = JSON.stringify(await failedResponse.json())
    expect(failedBody).toContain('The Source Document could not be parsed.')
    for (const forbidden of [
      'docling-parse',
      'PDFium',
      'C:\\private',
      '/api/runs',
      'a'.repeat(64),
    ])
      expect(failedBody).not.toContain(forbidden)
    expect(failed.packageStore.save).not.toHaveBeenCalled()
    expect(failed.store.ingestSourceDocument).not.toHaveBeenCalled()

    const cancelled = dependencies({}, { statuses: ['cancelling', 'cancelled'] })
    expect((await cancelled.handler(request())).status).toBe(422)
    expect(cancelled.packageStore.save).not.toHaveBeenCalled()

    const unknown = dependencies({}, { statuses: ['exploded'] })
    expect((await unknown.handler(request())).status).toBe(502)
    expect(unknown.packageStore.save).not.toHaveBeenCalled()

    const timeout = dependencies({ timeoutMs: 0 }, { statuses: ['queued'] })
    const timeoutResponse = await timeout.handler(request())
    expect(timeoutResponse.status).toBe(504)
    expect(await timeoutResponse.json()).toMatchObject({
      error: { message: 'Source Document parsing did not finish within thirty minutes.' },
    })
    expect(timeout.packageStore.save).not.toHaveBeenCalled()

    const stalled = dependencies({ timeoutMs: 1 })
    stalled.fetcher.mockReset()
    stalled.fetcher.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          ),
        ),
    )
    const stalledResponse = await stalled.handler(request())
    expect(stalledResponse.status).toBe(504)
    expect(stalled.packageStore.save).not.toHaveBeenCalled()

    for (const route of ['status', 'result', 'page'] as const) {
      const stalledRoute = dependencies(
        { timeoutMs: 10 },
        {
          respond: (current, fallback, init) =>
            current === route ? stalledBody(init?.signal) : fallback(),
        },
      )
      const stalledRouteResponse = await stalledRoute.handler(request())
      expect(stalledRouteResponse.status).toBe(504)
      expect(stalledRoute.packageStore.save).not.toHaveBeenCalled()
    }
  })

  it('refuses a run of other bytes, a partial result, and a page that fails its proof', async () => {
    const foreign = dependencies({}, { recordedSha256: '0'.repeat(64) })
    const foreignResponse = await foreign.handler(request())
    expect(foreignResponse.status).toBe(502)
    await expect(foreignResponse.json()).resolves.toMatchObject({
      error: { message: 'The Parsing Service recorded another Source Document.' },
    })
    expect(requestedPaths(foreign.fetcher)).toEqual(['/api/runs'])
    expect(foreign.packageStore.save).not.toHaveBeenCalled()

    const foreignResult = dependencies(
      {},
      {
        manifest: {
          recipe: { source_sha256: '0'.repeat(64), transcriber: 'native', model: null, versions: {} },
        },
      },
    )
    const foreignResultResponse = await foreignResult.handler(request())
    expect(foreignResultResponse.status).toBe(502)
    await expect(foreignResultResponse.json()).resolves.toMatchObject({
      error: { message: 'The parsed Source Document could not be translated.' },
    })
    expect(foreignResult.packageStore.save).not.toHaveBeenCalled()

    const partial = dependencies(
      {},
      { manifest: { status: 'incomplete', incomplete: 'page 1 stopped at its token cap' } },
    )
    const partialResponse = await partial.handler(request())
    expect(partialResponse.status).toBe(422)
    await expect(partialResponse.json()).resolves.toMatchObject({
      error: { message: 'The Source Document was only partially parsed.' },
    })
    expect(requestedPaths(partial.fetcher)).not.toContain('/api/runs/run-1/pages/1')
    expect(partial.packageStore.save).not.toHaveBeenCalled()

    const tampered = dependencies(
      {},
      {
        respond: (route, fallback) =>
          route === 'page'
            ? Response.json({ ...keiPage(), segments: [] })
            : fallback(),
      },
    )
    const tamperedResponse = await tampered.handler(request())
    expect(tamperedResponse.status).toBe(502)
    await expect(tamperedResponse.json()).resolves.toMatchObject({
      error: { message: 'The Parsing Service returned an invalid result.' },
    })
    expect(tampered.packageStore.save).not.toHaveBeenCalled()
    expect(tampered.store.ingestSourceDocument).not.toHaveBeenCalled()
  })

  it('maps rejected parser endpoints to stable public copy', async () => {
    // A 503 on the status read alone means "not yet" (tested above).
    const cases: Array<{ route: Route; status: number; message: string }> = [
      { route: 'submit', status: 503, message: 'Source Document parsing could not be started.' },
      { route: 'status', status: 500, message: 'Source Document parsing status is unavailable.' },
      { route: 'result', status: 503, message: 'The parsed Source Document could not be retrieved.' },
      { route: 'page', status: 503, message: 'The parsed Source Document could not be retrieved.' },
    ]

    for (const { route, status, message } of cases) {
      const current = dependencies(
        {},
        {
          respond: (candidate, fallback) =>
            candidate === route
              ? new Response('secret', { status })
              : fallback(),
        },
      )
      const result = await current.handler(request())
      expect(result.status).toBe(502)
      const body = JSON.stringify(await result.json())
      expect(body).toContain(message)
      expect(body).not.toContain('/api/runs')
      expect(body).not.toContain('secret')
      expect(current.packageStore.save).not.toHaveBeenCalled()
    }
  })

  it('maps invalid package retention and cleans only a first-published package after persistence failure', async () => {
    const invalid = dependencies()
    invalid.packageStore.save.mockRejectedValueOnce(new Error('bad archive'))
    const invalidResponse = await invalid.handler(request())
    expect(invalidResponse.status).toBe(502)
    expect(invalid.store.ingestSourceDocument).not.toHaveBeenCalled()

    const mismatched = dependencies()
    mismatched.packageStore.save.mockResolvedValueOnce({
      artifactReference: 'c'.repeat(64),
      artifactSha256: 'c'.repeat(64),
      document: {
        ...packageDocument,
        document: { content_sha256: '0'.repeat(64) },
      },
      published: true,
    })
    const mismatchResponse = await mismatched.handler(request())
    expect(mismatchResponse.status).toBe(502)
    expect(mismatched.store.ingestSourceDocument).not.toHaveBeenCalled()
    expect(mismatched.store.discardCanonicalPackage).toHaveBeenCalledOnce()

    const failed = dependencies()
    failed.store.ingestSourceDocument.mockRejectedValueOnce(
      new Error('db down'),
    )
    const failedResponse = await failed.handler(request())
    expect(failedResponse.status).toBe(503)
    expect(failed.store.discardCanonicalPackage).toHaveBeenCalledWith({
      artifactReference: 'a'.repeat(64),
      artifactSha256: 'a'.repeat(64),
    })

    const replay = dependencies()
    replay.packageStore.save.mockResolvedValueOnce({
      artifactReference: 'b'.repeat(64),
      artifactSha256: 'b'.repeat(64),
      document: packageDocument,
      published: false,
    })
    replay.store.ingestSourceDocument.mockRejectedValueOnce(
      new Error('db down'),
    )
    await replay.handler(request())
    expect(replay.store.discardCanonicalPackage).not.toHaveBeenCalled()
  })
})

describe('Source Document reprocessing', () => {
  it('parses retained bytes, publishes a revision, and replays without parsing', async () => {
    const { createSourceDocumentReprocessing } =
      await import('./source_reprocess.js')
    const { fetcher, packageStore, store: ingestionStore } = dependencies()
    const retained = {
      artifactReference: 'a'.repeat(64),
      artifactSha256: 'a'.repeat(64),
    }
    const result = {
      sourceDocumentId: ids.source,
      name: 'report.pdf',
      createdAt: new Date(),
      sourceRepresentationId: ids.representation,
      revisionNumber: 2,
      descriptor: retained,
    }
    const store = {
      discardCanonicalPackage: ingestionStore.discardCanonicalPackage,
      getDocumentReopenSnapshot: vi
        .fn()
        .mockResolvedValue({
          sourceDocument: { name: 'report.pdf' },
          sourceRepresentation: { sourceRepresentationId: ids.representation },
        }),
      getSourceRepresentation: vi.fn().mockResolvedValue(retained),
      findReprocessedSourceDocument: vi.fn().mockResolvedValue(null),
      reprocessSourceDocument: vi.fn().mockResolvedValue(result),
    }
    const handler = createSourceDocumentReprocessing(store, {
      fetcher,
      packageStore,
      parsingServiceBase: 'http://parser.test',
      sleep: async () => {},
      readPackage: async (_descriptor, artifact) => ({
        bytes: encoder.encode(
          artifact === 'pdf' ? '%PDF-1.7\n' : JSON.stringify(packageDocument),
        ),
        mediaType: 'application/json',
      }),
    })
    const request = () =>
      new Request(
        `http://test/api/project-contexts/${ids.project}/source-documents/${ids.source}/reprocess`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestKey: ids.ingestion,
            expectedRepresentationId: ids.representation,
            layout: 'pages',
          }),
        },
      )
    const response = await handler(request())
    expect(response.status).toBe(201)
    expect((await response.json()).revisionNumber).toBe(2)
    expect(store.reprocessSourceDocument).toHaveBeenCalledWith(
      ids.project,
      ids.source,
      expect.objectContaining({
        contentSha256: UPLOAD_SHA256,
        expectedRepresentationId: ids.representation,
      }),
    )
    store.findReprocessedSourceDocument.mockResolvedValue(result)
    fetcher.mockClear()
    expect((await handler(request())).status).toBe(200)
    expect(fetcher).not.toHaveBeenCalled()
    store.findReprocessedSourceDocument.mockResolvedValue(null)
    store.getDocumentReopenSnapshot.mockResolvedValue({
      sourceDocument: { name: 'report.pdf' },
      sourceRepresentation: { sourceRepresentationId: ids.source },
    })
    expect((await handler(request())).status).toBe(409)
    expect(fetcher).not.toHaveBeenCalled()
    store.getDocumentReopenSnapshot.mockResolvedValue(null)
    expect((await handler(request())).status).toBe(404)
  })
})
