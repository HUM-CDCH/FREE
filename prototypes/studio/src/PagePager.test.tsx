// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PagePager from './PagePager'

afterEach(cleanup)

/** The pager as the workspace mounts it: navigating moves the viewer, whose page comes back as the prop. */
function Viewer({ start = 2, pageCount = 7, onNavigate }: { start?: number; pageCount?: number; onNavigate?: (page: number) => void }) {
  const [page, setPage] = useState(start)
  return <PagePager page={page} pageCount={pageCount} onNavigate={(next) => { onNavigate?.(next); setPage(next) }} />
}

const input = () => screen.getByLabelText<HTMLInputElement>('Current page')

describe('PagePager', () => {
  it('Next navigates to the following page and keeps focus on itself', () => {
    const onNavigate = vi.fn()
    render(<Viewer start={2} onNavigate={onNavigate} />)
    const next = screen.getByRole('button', { name: 'Next page' })
    next.focus()
    fireEvent.click(next)
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(3)
    expect(input()).toHaveValue('3')
    expect(screen.getByRole('button', { name: 'Next page' })).toBe(next)
    expect(next).toHaveFocus()
  })

  it('a page change resets the draft unless the researcher is typing one', () => {
    const { rerender } = render(<PagePager page={2} pageCount={7} onNavigate={vi.fn()} />)
    rerender(<PagePager page={4} pageCount={7} onNavigate={vi.fn()} />)
    expect(input()).toHaveValue('4')

    input().focus()
    fireEvent.change(input(), { target: { value: '6' } })
    rerender(<PagePager page={5} pageCount={7} onNavigate={vi.fn()} />)
    expect(input()).toHaveValue('6')
    expect(input()).toHaveFocus()
  })

  it('a focused draft the researcher has not touched follows the viewer, so a blur does not move it back', () => {
    const onNavigate = vi.fn()
    const { rerender } = render(<PagePager page={2} pageCount={7} onNavigate={onNavigate} />)
    input().focus()
    rerender(<PagePager page={5} pageCount={7} onNavigate={onNavigate} />)
    expect(input()).toHaveValue('5')
    fireEvent.blur(input())
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('Enter on a page navigates; anything else resets on blur', () => {
    const onNavigate = vi.fn()
    render(<Viewer start={2} onNavigate={onNavigate} />)
    fireEvent.change(input(), { target: { value: '5' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(5)
    for (const invalid of ['0', '999', 'abc']) {
      fireEvent.change(input(), { target: { value: invalid } })
      fireEvent.blur(input())
      expect(input()).toHaveValue('5')
    }
    expect(onNavigate).toHaveBeenCalledOnce()
  })

  it('offers no Previous on the first page and no Next on the last', () => {
    const { rerender } = render(<PagePager page={1} pageCount={7} onNavigate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled()
    rerender(<PagePager page={7} pageCount={7} onNavigate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
  })
})
