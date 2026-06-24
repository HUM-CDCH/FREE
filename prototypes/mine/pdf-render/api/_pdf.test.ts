import { afterEach, describe, expect, it, vi } from 'vitest'
import { pdfFileParts } from './_pdf'

afterEach(() => vi.unstubAllGlobals())

describe('pdfFileParts', () => {
  it('converts PDF source documents with the parsing service when it is reachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            pages: 1,
            images: [
              {
                filename: 'page_01.png',
                media_type: 'image/png',
                data_url: 'data:image/png;base64,cGFnZQ==',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )

    const converted = await pdfFileParts(
      new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' }),
    )

    expect(converted).toEqual({
      pages: 1,
      parts: [
        {
          type: 'file',
          data: 'data:image/png;base64,cGFnZQ==',
          filename: 'page_01.png',
          mediaType: 'image/png',
        },
      ],
    })
  })
})
