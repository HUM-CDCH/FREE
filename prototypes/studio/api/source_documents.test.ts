import { describe, expect, it, vi } from 'vitest'
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
const packageDocument = {
  schema_version: 'parsed_document.v2',
  page_count: 12,
  document: {
    content_sha256:
      '0716f9264c9fe19f5d7455276107f3ddcc1d3497f63d60689a73558ae8a1bf5e',
  },
  preprocessing: { preprocess_id: 'preprocess-1' },
  arbitration: { primary_document_parser: 'docling' },
  parser_runs: [{ parser: 'docling', version: '2.0' }],
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

function parser(
  fetcher: ReturnType<typeof vi.fn>,
  status: unknown = { status: 'completed' },
) {
  fetcher
    .mockResolvedValueOnce(
      Response.json({ task_id: 'task-1' }, { status: 202 }),
    )
    .mockResolvedValueOnce(Response.json(status))
    .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
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

function dependencies(overrides: Record<string, unknown> = {}) {
  const fetcher = vi.fn()
  parser(fetcher)
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
          new File([new Uint8Array(50 * 1024 * 1024 + 1)], 'large.pdf', {
            type: 'application/pdf',
          }),
        ],
        ['ingestionKey', ids.ingestion],
      ]),
    )
    expect(oversized.status).toBe(413)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('parses, validates provenance, and persists one sanitized PDF', async () => {
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
        parserName: 'docling',
        parserVersion: '2.0',
      }),
    )
    const upload = fetcher.mock.calls[0]?.[1]?.body as FormData
    expect((upload.get('file') as File).name).toBe('report draft.pdf')
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

  it('prefers the production runtime Parsing Service address', async () => {
    const { fetcher, store, packageStore } = dependencies()
    vi.stubEnv('PARSING_SERVICE_URL', 'http://runtime-parser.test')
    try {
      const handler = createSourceDocumentIngestion(store, {
        fetcher,
        packageStore,
        sleep: async () => {},
      })
      expect((await handler(request())).status).toBe(201)
      expect(String(fetcher.mock.calls[0]?.[0])).toBe(
        'http://runtime-parser.test/tasks',
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('returns the durable store result when the same request is replayed', async () => {
    const { handler, fetcher, store } = dependencies()
    parser(fetcher)

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
    const { handler, fetcher, store } = dependencies()
    fetcher.mockReset()
    fetcher.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/tasks') && init?.method === 'POST')
        return Response.json({ task_id: crypto.randomUUID() }, { status: 202 })
      if (url.endsWith('/download'))
        return new Response(new Uint8Array([1, 2, 3]))
      return Response.json({ status: 'completed' })
    })

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

  it('does not publish or persist when parsing fails or times out', async () => {
    const failed = dependencies()
    failed.fetcher.mockReset()
    parser(failed.fetcher, {
      status: 'failed',
      error:
        'docling-parse PDFium C:\\private\\source.pdf /tasks/task-1 ' +
        'a'.repeat(64),
    })
    const failedResponse = await failed.handler(request())
    expect(failedResponse.status).toBe(422)
    const failedBody = JSON.stringify(await failedResponse.json())
    expect(failedBody).toContain('The Source Document could not be parsed.')
    for (const forbidden of [
      'docling-parse',
      'PDFium',
      'C:\\private',
      '/tasks',
      'a'.repeat(64),
    ])
      expect(failedBody).not.toContain(forbidden)
    expect(failed.packageStore.save).not.toHaveBeenCalled()
    expect(failed.store.ingestSourceDocument).not.toHaveBeenCalled()

    const timeout = dependencies({ timeoutMs: 0 })
    timeout.fetcher.mockReset()
    timeout.fetcher
      .mockResolvedValueOnce(Response.json({ task_id: 'task-1' }))
      .mockResolvedValueOnce(Response.json({ status: 'pending' }))
    const timeoutResponse = await timeout.handler(request())
    expect(timeoutResponse.status).toBe(504)
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

    const stalledStatus = dependencies({ timeoutMs: 10 })
    stalledStatus.fetcher.mockReset()
    stalledStatus.fetcher
      .mockResolvedValueOnce(Response.json({ task_id: 'task-1' }))
      .mockImplementationOnce((_url: string, init?: RequestInit) =>
        Promise.resolve(stalledBody(init?.signal)),
      )
    const stalledStatusResponse = await stalledStatus.handler(request())
    expect(stalledStatusResponse.status).toBe(504)
    expect(stalledStatus.packageStore.save).not.toHaveBeenCalled()

    const stalledDownload = dependencies({ timeoutMs: 10 })
    stalledDownload.fetcher.mockReset()
    stalledDownload.fetcher
      .mockResolvedValueOnce(Response.json({ task_id: 'task-1' }))
      .mockResolvedValueOnce(Response.json({ status: 'completed' }))
      .mockImplementationOnce((_url: string, init?: RequestInit) =>
        Promise.resolve(stalledBody(init?.signal)),
      )
    const stalledDownloadResponse = await stalledDownload.handler(request())
    expect(stalledDownloadResponse.status).toBe(504)
    expect(stalledDownload.packageStore.save).not.toHaveBeenCalled()
  })

  it('maps rejected parser endpoints to stable public copy', async () => {
    const cases = [
      {
        responses: [new Response('secret', { status: 503 })],
        message: 'Source Document parsing could not be started.',
      },
      {
        responses: [
          Response.json({ task_id: 'task-1' }, { status: 202 }),
          new Response('secret', { status: 503 }),
        ],
        message: 'Source Document parsing status is unavailable.',
      },
      {
        responses: [
          Response.json({ task_id: 'task-1' }, { status: 202 }),
          Response.json({ status: 'completed' }),
          new Response('secret', { status: 503 }),
        ],
        message: 'The parsed Source Document could not be retrieved.',
      },
    ]

    for (const { responses, message } of cases) {
      const current = dependencies()
      current.fetcher.mockReset()
      for (const response of responses)
        current.fetcher.mockResolvedValueOnce(response)
      const result = await current.handler(request())
      expect(result.status).toBe(502)
      const body = JSON.stringify(await result.json())
      expect(body).toContain(message)
      expect(body).not.toContain('/tasks')
      expect(body).not.toContain('secret')
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
