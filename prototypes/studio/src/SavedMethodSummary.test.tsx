// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { REFERENCE_ARTICLE } from 'extraction/extraction-method'
import { SavedMethodSummary } from './SavedMethodSummary'

afterEach(cleanup)
const ready = { status: 'ready' as const, config: {} as never }

it('shows the saved method it will submit, expandable', () => {
  render(<SavedMethodSummary variant="panel" saved={ready} conflict={null} onRefresh={vi.fn()}
    method={{ models: { fields: 'instruct' }, settings: { article: { ...REFERENCE_ARTICLE, grounding: 'spans' } } }} />)
  fireEvent.click(screen.getByText('Saved advanced settings', { exact: false }))
  expect(screen.getByText('Full source · Plain text · Source-span verification')).toBeInTheDocument()
  expect(screen.getByText('Field values: instruct · Reasoning: deployment default')).toBeInTheDocument()
})

it('a stale preview opens with the refusal and a refresh', () => {
  const onRefresh = vi.fn()
  render(<SavedMethodSummary variant="toolbar" saved={ready} method={{ models: null, settings: { article: null } }}
    conflict="Your saved advanced settings changed after this summary was shown. Nothing was started; review the updated summary and start again."
    onRefresh={onRefresh} />)
  expect(screen.getByRole('alert')).toHaveTextContent('Nothing was started')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh summary' }))
  expect(onRefresh).toHaveBeenCalledOnce()
})

it('an unreadable configuration offers a retry and says nothing can start', () => {
  const onRefresh = vi.fn()
  render(<SavedMethodSummary variant="panel" saved={{ status: 'error', message: 'x' }} method={null} conflict={null} onRefresh={onRefresh} />)
  expect(screen.getByRole('alert')).toHaveTextContent('Nothing can start until they load.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(onRefresh).toHaveBeenCalledOnce()
})
