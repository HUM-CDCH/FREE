// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PageNavigation } from './PageNavigation'
import type { ThumbnailRenderer } from './PageThumbnails'

HTMLElement.prototype.scrollIntoView = vi.fn()
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const rail = (thumbnails: ThumbnailRenderer | null, currentPage = 2) => {
  const onNavigate = vi.fn()
  render(<PageNavigation id="pages" pageCount={3} currentPage={currentPage} onNavigate={onNavigate} onClose={vi.fn()} thumbnails={thumbnails} />)
  return onNavigate
}

it('renders one thumbnail card per page, numbered, and rings the current page', () => {
  rail(null)
  const buttons = screen.getAllByRole('button', { name: /^Go to page \d$/ })
  expect(buttons).toHaveLength(3)
  expect(buttons[1]).toHaveAttribute('aria-current', 'page')
  expect(buttons[1]!.className).toMatch(/ring-ink/)
  expect(buttons[0]!.className).not.toMatch(/ring-ink/)
  expect(buttons.map((button) => button.textContent)).toEqual(['1', '2', '3'])
  expect(buttons[0]!.querySelector('canvas')).toHaveAttribute('data-thumbnail', 'pending')
})

it('draws each bitmap once it arrives and marks a missing one unavailable', async () => {
  const drawImage = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
  const portrait = { width: 73, height: 95 } as ImageBitmap
  const landscape = { width: 95, height: 73 } as ImageBitmap
  const render = vi.fn(async (page: number) => (page === 1 ? portrait : page === 2 ? landscape : null))
  rail({ render, dispose: vi.fn() })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Go to page 1' }).querySelector('canvas')).toHaveAttribute('data-thumbnail', 'drawn'))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Go to page 2' }).querySelector('canvas')).toHaveAttribute('data-thumbnail', 'drawn'))
  expect(screen.getByRole('button', { name: 'Go to page 3' }).querySelector('canvas')).toHaveAttribute('data-thumbnail', 'unavailable')
  expect(drawImage).toHaveBeenCalledTimes(2)
  expect(render).toHaveBeenCalledTimes(3)
  // Fitted inside the 46×58 card, aspect ratio kept, centred.
  const drawn = (bitmap: ImageBitmap) => drawImage.mock.calls.find(([image]) => image === bitmap)!.slice(1) as number[]
  const [portraitX, portraitY, portraitWidth, portraitHeight] = drawn(portrait)
  expect(portraitHeight).toBeCloseTo(58)
  expect(portraitWidth).toBeCloseTo(44.57, 1)
  expect(portraitX).toBeCloseTo(0.72, 1)
  expect(portraitY).toBeCloseTo(0)
  const [landscapeX, landscapeY, landscapeWidth, landscapeHeight] = drawn(landscape)
  expect(landscapeWidth).toBeCloseTo(46)
  expect(landscapeHeight).toBeCloseTo(35.35, 1)
  expect(landscapeY).toBeCloseTo(11.33, 1)
  expect(landscapeX).toBeCloseTo(0)
})

it('keeps the keyboard model: arrows, Home and End move and navigate, Escape closes', () => {
  const onNavigate = rail(null, 1)
  const first = screen.getByRole('button', { name: 'Go to page 1' })
  first.focus()
  fireEvent.keyDown(first, { key: 'End' })
  expect(onNavigate).toHaveBeenLastCalledWith(3)
  fireEvent.keyDown(screen.getByRole('button', { name: 'Go to page 3' }), { key: 'ArrowUp' })
  expect(onNavigate).toHaveBeenLastCalledWith(2)
})
