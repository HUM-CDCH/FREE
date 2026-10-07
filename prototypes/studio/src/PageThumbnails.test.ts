import { describe, expect, it, vi } from 'vitest'
import { createThumbnailRenderer } from './PageThumbnails'

const bitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap
const pdf = { getPage: vi.fn() } as never

describe('createThumbnailRenderer', () => {
  it('paints each page once and hands out the same bitmap again', async () => {
    const paint = vi.fn(async (_pdf: unknown, page: number) => (page === 2 ? null : bitmap()))
    const renderer = createThumbnailRenderer(pdf, paint)
    const [first, again, missing] = await Promise.all([renderer.render(1), renderer.render(1), renderer.render(2)])
    expect(first).toBe(again)
    expect(missing).toBeNull()
    expect(paint).toHaveBeenCalledTimes(2)
  })

  it('a failing paint is a blank thumbnail, never an error', async () => {
    const renderer = createThumbnailRenderer(pdf, vi.fn(async () => { throw new Error('no page') }))
    await expect(renderer.render(1)).resolves.toBeNull()
  })

  it('dispose closes every bitmap and forgets the cache', async () => {
    const first = bitmap()
    const paint = vi.fn(async () => first)
    const renderer = createThumbnailRenderer(pdf, paint)
    await renderer.render(1)
    renderer.dispose()
    await Promise.resolve()
    expect(first.close).toHaveBeenCalledOnce()
    await renderer.render(1)
    expect(paint).toHaveBeenCalledTimes(2)
  })

  it('a bitmap that arrives after dispose is closed too', async () => {
    const late = bitmap()
    const { promise, resolve } = Promise.withResolvers<ImageBitmap | null>()
    const renderer = createThumbnailRenderer(pdf, vi.fn(() => promise))
    const pending = renderer.render(1)
    renderer.dispose()
    expect(late.close).not.toHaveBeenCalled()
    resolve(late)
    await pending
    await Promise.resolve()
    expect(late.close).toHaveBeenCalledOnce()
  })
})
