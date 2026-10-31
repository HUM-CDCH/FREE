// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import PilotReviewGuide from './PilotReviewGuide'

afterEach(cleanup)

it('says what to do on an unreviewed document and offers the next one', () => {
  const onNext = vi.fn()
  render(<PilotReviewGuide reviewed={1} total={2} currentReviewed={false} onNext={onNext} onBackToBatch={vi.fn()} />)
  expect(screen.getByRole('region', { name: 'Pilot review' })).toHaveTextContent('1 of 2 documents reviewed')
  expect(screen.getByText(/highlighted source/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Next document' }))
  expect(onNext).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: 'Back to Batch Extraction' })).not.toBeInTheDocument()
})

it('leads back to the Batch Extraction once every member of the round is reviewed', () => {
  const onBackToBatch = vi.fn()
  render(<PilotReviewGuide reviewed={2} total={2} currentReviewed onBackToBatch={onBackToBatch} />)
  expect(screen.queryByRole('button', { name: 'Next document' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Back to Batch Extraction' }))
  expect(onBackToBatch).toHaveBeenCalledOnce()
})
