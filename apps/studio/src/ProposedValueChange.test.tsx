// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'
import ReviewRow from './ReviewRow'
import type { ProposedChange } from './ProposedValueChange'
import type { RailRow } from './reviewVocabulary'

afterEach(cleanup)

const row = (value: unknown, kind: RailRow['kind'] = 'to-check') => ({
  key: 'value-1', resultPath: ['year'], name: 'year', value, extracted: value, kind, link: null, chip: null, evidence: null, doubt: null,
  changed: false, page: null,
}) as unknown as RailRow
const shown = (value: unknown, proposed: ProposedChange | null, kind?: RailRow['kind']) => render(
  <ReviewRow row={row(value, kind)} selected={false} pinned={false} onSelect={() => {}} canDecide={false} saved={false} editing={false}
    node={null} onDecide={() => {}} onEdit={() => {}} onCancelEdit={() => {}} onUndo={() => {}} proposed={proposed} />)

describe('a value the chat proposes to change, in Results (ADR 0035)', () => {
  it('strikes the value in red and shows what it becomes in green', () => {
    shown(1845, { action: 'EDITED', current: 1845, value: 1854 })
    const before = screen.getByText('1845', { selector: 's' })
    expect(before).toHaveClass('text-danger')
    expect(screen.getByText('1854')).toHaveClass('text-green')
    expect(screen.getByRole('button')).toHaveAccessibleName(/change proposed in the chat/)
  })

  it('shows only the new value for a missing one filled in', () => {
    shown(null, { action: 'EDITED', current: null, value: 1854 }, 'missing')
    expect(screen.getByText('1854')).toHaveClass('text-green')
    expect(document.querySelector('s')).toBeNull()
    expect(screen.queryByText('→')).not.toBeInTheDocument()
  })

  it('strikes a rejected value and says it is rejected', () => {
    shown('Ane', { action: 'REJECTED', current: 'Ane' })
    expect(screen.getByText('Ane', { selector: 's' })).toHaveClass('text-danger')
    expect(screen.getByText('rejected')).toBeInTheDocument()
  })

  it('shows the value as it is without a proposal', () => {
    shown(1845, null)
    expect(screen.getByText('1845')).not.toHaveClass('text-danger')
    expect(document.querySelector('s')).toBeNull()
  })
})
