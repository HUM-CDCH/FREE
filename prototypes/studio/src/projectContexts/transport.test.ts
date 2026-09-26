import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ingestSourceDocument,
  ProjectContextRequestError,
  reprocessSourceDocument,
  toProjectContextFailure,
  uncertainFailure,
} from './transport.js'

afterEach(() => vi.unstubAllGlobals())

const project = '11111111-1111-4111-8111-111111111111'
const ingested = {
  sourceDocumentId: '33333333-3333-4333-8333-333333333333',
  name: 'report.pdf',
  createdAt: '2026-08-12T10:00:00.000Z',
  sourceRepresentationId: '44444444-4444-4444-8444-444444444444',
  revisionNumber: 1,
  pageCount: 12,
}

describe('ingestSourceDocument', () => {
  it('posts one PDF and its layout to the Project Context route, and no key', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(ingested))
    vi.stubGlobal('fetch', fetcher)
    const file = new File(['%PDF-1.7\n'], 'report.pdf', { type: 'application/pdf' })

    await expect(ingestSourceDocument(project, file)).resolves.toMatchObject({
      sourceDocumentId: '33333333-3333-4333-8333-333333333333',
    })

    expect(fetcher).toHaveBeenCalledWith(
      `/api/project-contexts/${project}/source-documents`,
      expect.objectContaining({
        method: 'POST',
        body: expect.any(FormData),
        credentials: 'same-origin',
      }),
    )
    const form = fetcher.mock.calls[0]?.[1]?.body as FormData
    expect(form.get('file')).toBeInstanceOf(File)
    expect([...form.keys()]).toEqual(['file', 'layout'])
    expect(form.get('ingestionKey')).toBeNull()
  })

  it('sends the page layout with the PDF, single pages unless spreads are chosen', async () => {
    const fetcher = vi.fn(async () => Response.json({ ...ingested, name: 'catalogue.pdf', pageCount: 45 }))
    vi.stubGlobal('fetch', fetcher)
    const file = new File(['%PDF-1.7\n'], 'catalogue.pdf', { type: 'application/pdf' })
    await ingestSourceDocument(project, file, 'spreads')
    await ingestSourceDocument(project, file)
    const sent = fetcher.mock.calls.map((call) => ((call as unknown[])[1] as RequestInit).body as FormData)
    expect(sent.map((form) => form.get('layout'))).toEqual(['spreads', 'pages'])
  })
})

describe('a failed request', () => {
  const reprocess = () =>
    reprocessSourceDocument(project, '33333333-3333-4333-8333-333333333333', {
      requestKey: '55555555-5555-4555-8555-555555555555',
      expectedRepresentationId: '44444444-4444-4444-8444-444444444444',
      layout: 'pages',
    })

  it("carries the HTTP status and the server's bounded failure", async () => {
    const failure = { code: 'source_ingestion_failed', message: 'Parser temporarily unavailable.' }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: failure }, { status: 503 })))

    const error = await reprocess().catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ProjectContextRequestError)
    expect(error).toMatchObject({ status: 503, failure })
    expect(toProjectContextFailure(error)).toEqual(failure)
  })

  it('reads a network error, 502, 503 and 504 as uncertain and any other refusal as confirmed', async () => {
    for (const [status, uncertain] of [[502, true], [503, true], [504, true], [409, false], [422, false], [404, false]] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('proxy error page', { status })))
      const error = await reprocess().catch((cause: unknown) => cause)
      expect(error, String(status)).toMatchObject({ status })
      expect(uncertainFailure(error), String(status)).toBe(uncertain)
      // A body that is not the bounded shape reads as unavailable storage.
      expect(toProjectContextFailure(error).code).toBe('persistence_unavailable')
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(uncertainFailure(await reprocess().catch((cause: unknown) => cause))).toBe(true)
  })
})
