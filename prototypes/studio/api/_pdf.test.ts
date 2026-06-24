import { describe, expect, it } from 'vitest'
import { documentFileParts } from './_pdf'

describe('documentFileParts', () => {
  it('passes non-PDF image documents through as a single file part', async () => {
    const prepared = await documentFileParts(
      new File([new Uint8Array([1, 2, 3])], 'page.png', { type: 'image/png' }),
    )

    expect(prepared.pages).toBeNull()
    expect(prepared.parts).toEqual([
      {
        type: 'file',
        data: expect.any(Uint8Array),
        filename: 'page.png',
        mediaType: 'image/png',
      },
    ])
  })
})
