// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import AppFrame from './AppFrame'

vi.mock('./projectContexts/ProjectContextRail', () => ({ ProjectContextRail: () => null }))
vi.mock('./projectContexts/StudioHome', () => ({ StudioHome: () => <p>Home</p> }))
vi.mock('./projectContexts/useProjectContexts', () => ({ useProjectContexts: () => ({ projects: [], branches: {}, refreshProjects: vi.fn() }) }))
afterEach(() => { cleanup(); localStorage.clear(); document.body.style.cursor = '' })

function frame() {
  const commits = vi.fn()
  const mounted = render(<Profiler id="frame" onRender={commits}><AppFrame route={{ kind: 'root' }}
    routedProjectContext={{ branch: undefined, documentContained: null }} openDocument={null} opening={false} failure={null}
    onNavigate={vi.fn()} onRetry={vi.fn()} onInitialResourceLoadFailure={vi.fn()} onRefreshDocument={vi.fn()} onRefreshReviewed={vi.fn()} /></Profiler>)
  commits.mockClear()
  return { ...mounted, commits, separator: screen.getByRole('separator', { name: 'Resize project navigation' }) }
}

it('changes navigation width through a drag, then commits once and preserves keyboard resizing', () => {
  const { commits, separator } = frame()
  const nav = document.querySelector<HTMLElement>('[data-project-rail]')!
  fireEvent.mouseDown(separator, { clientX: 200 })
  for (let i = 1; i <= 20; i++) fireEvent.mouseMove(window, { clientX: 200 + i })
  expect(nav.style.getPropertyValue('--nav-width') || nav.style.width).toBe('232px')
  expect(commits.mock.calls.length).toBe(0)
  fireEvent.mouseUp(window)
  expect(commits.mock.calls.length).toBe(1)
  expect(separator).toHaveAttribute('aria-valuenow', '232')
  fireEvent.keyDown(separator, { key: 'ArrowRight' })
  expect(nav.style.getPropertyValue('--nav-width')).toBe('242px')
  expect(separator).toHaveAttribute('aria-valuenow', '242')
})

it('clamps a navigation drag and releases its listeners on unmount', () => {
  const { separator, unmount } = frame()
  fireEvent.mouseDown(separator, { clientX: 200 })
  fireEvent.mouseMove(window, { clientX: 900 })
  expect(document.querySelector<HTMLElement>('[data-project-rail]')!.style.getPropertyValue('--nav-width')).toBe('400px')
  unmount()
  expect(document.body.style.cursor).toBe('')
  fireEvent.mouseMove(window, { clientX: 0 })
  fireEvent.mouseUp(window)
})
