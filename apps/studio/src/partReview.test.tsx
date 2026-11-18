// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { EvidenceLink } from 'extraction/durable-types'
import type { SchemaNode } from 'extraction/schema'
import { partKey, type ValuePart } from './durableRailModel'
import { partFlag, partState } from './partReview'
import ReviewedValueDisplay, { type PartPick } from './ui/ReviewedValueDisplay'

const link = (verbatim: boolean) => ({ verbatim }) as unknown as EvidenceLink
const part = (row: number, column: string, value: unknown, evidence: EvidenceLink | null): ValuePart =>
  ({ key: partKey('v1', ['sizes', row, column]), path: ['sizes', row, column],
    name: 'sizes › #' + (row + 1) + ' › ' + column, value, link: evidence, reviewable: value !== null })
const exact = part(0, 'baseline', 52, link(true)), inexact = part(0, 'week12', 41, link(false))
const unlinked = part(1, 'baseline', 50, null), empty = part(1, 'week12', null, null)
const node = { id: 't', name: 'sizes', type: 'array', children: [
  { id: 'a', name: 'baseline', type: 'integer' }, { id: 'b', name: 'week12', type: 'integer' },
] } as unknown as SchemaNode
const value = [{ baseline: 52, week12: 41 }, { baseline: 50, week12: null }]

afterEach(cleanup)

it('uses individual approval and Evidence, and keeps old whole approvals neutral at cell level', () => {
  expect([exact, inexact, unlinked, empty].map(partFlag))
    .toEqual([null, 'Not an exact match, please double check', 'Source not found', null])
  expect(partState(inexact)).toBe('to-check')
  expect(partState({ ...inexact, approved: true }, true)).toBe('approved')
  expect(partState(inexact, true)).toBe('unrecorded')
  expect(partState(exact)).toBe('unread')
})

it('offers approval and undo for the selected cell only', () => {
  const onApproval = vi.fn()
  const pick = (selected: string, approved: string[], wholeApproved = false): PartPick => ({
    valueId: 'v1', selected, onPick: vi.fn(), review: { open: true, wholeApproved, onApproval },
    parts: new Map([exact, inexact, unlinked, empty].map(each=>[each.key,{...each,approved:approved.includes(each.key)}])),
  })
  const view = render(<ReviewedValueDisplay node={node} value={value} path={['sizes']} pick={pick(inexact.key, [exact.key])} />)
  expect(screen.getAllByRole('rowheader').map(each => each.textContent)).toEqual(['1', '2'])
  expect(screen.getByRole('columnheader', { name: 'week12' }).className).toContain('bg-ev-soft')
  expect(screen.getByRole('columnheader', { name: 'baseline' }).className).not.toContain('bg-ev-soft')
  expect(screen.getByRole('rowheader', { name: '1' }).className).toContain('bg-ev-soft')
  screen.getByRole('button', { name: 'sizes › #1 › baseline: 52, approved' })
  screen.getByRole('button', { name: 'sizes › #1 › week12: 41, to check' })
  screen.getByRole('button', { name: 'sizes › #2 › baseline: 50, to check' })
  const decision = within(screen.getByRole('group', { name: 'Decision for sizes › #1 › week12' }))
  fireEvent.click(decision.getByRole('button', { name: 'Approve' }))
  expect(onApproval).toHaveBeenCalledWith(expect.objectContaining({ path: inexact.path }), true)
  view.rerender(<ReviewedValueDisplay node={node} value={value} path={['sizes']} pick={pick(inexact.key, [exact.key,inexact.key], true)} />)
  screen.getByRole('button', { name: 'sizes › #2 › baseline: 50, no individual approval recorded' })
  fireEvent.click(decision.getByRole('button', { name: 'Undo approval' }))
  expect(onApproval).toHaveBeenLastCalledWith(expect.objectContaining({ path: inexact.path }), false)
  expect(screen.queryByText(/accepted, not read/i)).toBeNull()
})
