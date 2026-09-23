import { afterEach, describe, expect, it, vi } from 'vitest'
import { ingestSourceDocument } from './transport.js'

afterEach(() => vi.unstubAllGlobals())

describe('ingestSourceDocument', () => {
  it('posts one PDF and its stable ingestion key to the Project Context route', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        sourceDocumentId: '33333333-3333-4333-8333-333333333333',
        name: 'report.pdf',
        createdAt: '2026-08-12T10:00:00.000Z',
        sourceRepresentationId: '44444444-4444-4444-8444-444444444444',
        revisionNumber: 1,
        pageCount: 12,
      }),
    )
    vi.stubGlobal('fetch', fetcher)
    const file = new File(['%PDF-1.7\n'], 'report.pdf', { type: 'application/pdf' })

    await expect(
      ingestSourceDocument(
        '11111111-1111-4111-8111-111111111111',
        file,
        '22222222-2222-4222-8222-222222222222',
      ),
    ).resolves.toMatchObject({ sourceDocumentId: '33333333-3333-4333-8333-333333333333' })

    expect(fetcher).toHaveBeenCalledWith(
      '/api/project-contexts/11111111-1111-4111-8111-111111111111/source-documents',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(FormData),
        credentials: 'same-origin',
      }),
    )
    const form = fetcher.mock.calls[0]?.[1]?.body as FormData
    expect(form.get('file')).toBeInstanceOf(File)
    expect(form.get('ingestionKey')).toBe('22222222-2222-4222-8222-222222222222')
  })

  it('sends the page layout with the PDF, single pages unless spreads are chosen', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        sourceDocumentId: '33333333-3333-4333-8333-333333333333',
        name: 'catalogue.pdf',
        createdAt: '2026-08-12T10:00:00.000Z',
        sourceRepresentationId: '44444444-4444-4444-8444-444444444444',
        revisionNumber: 1,
        pageCount: 45,
      }),
    )
    vi.stubGlobal('fetch', fetcher)
    const file = new File(['%PDF-1.7\n'], 'catalogue.pdf', { type: 'application/pdf' })
    const project = '11111111-1111-4111-8111-111111111111'
    await ingestSourceDocument(project, file, '22222222-2222-4222-8222-222222222222', 'spreads')
    await ingestSourceDocument(project, file, '22222222-2222-4222-8222-222222222223')
    const sent = fetcher.mock.calls.map((call) => ((call as unknown[])[1] as RequestInit).body as FormData)
    expect(sent.map((form) => form.get('layout'))).toEqual(['spreads', 'pages'])
  })
})
