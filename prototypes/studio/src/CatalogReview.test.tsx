// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { unifiedDiagnosticsSchema } from '../shared/extraction.contract'
import { CatalogReview } from './CatalogReview'

afterEach(cleanup)
const span = { segment: 'p2_s0', start: 0, end: 12 }
const candidate = { value: 'Nadel', quote: 'Nadel', support: 'literal', spans: [span], alternatives: [], window: 1, raw: 'Nadel' }
const unified = unifiedDiagnosticsSchema.parse({
  method: { requested: { defaults: 1 }, effective: { overlap: 1 } },
  records: { execution: 'e'.repeat(64), discovery: 'd'.repeat(64) },
  entries: 3,
  unsettledEntries: [{ id: 'p1_s0@0', label: '12.', end: 'unresolved' }],
  unresolved: [span], withheld: [],
  processing: { discovery: { windows: 3, failed: 1 }, entries: { entries: 3, windows: 5, failed: 0 },
    verification: { enabled: true, undecided: 0 }, document: { applicable: true, windows: 2, failed: 0 } },
  completeness: { accounting: true, boundaries: false, processing: false, evidence: false, recall: 'unmeasured' },
  proposed: [{ ...candidate, path: ['records', 0, 'finds', null, 'name'], reason: 'partial_item', item: { window: 1, index: 0 } }],
  rejected: [{ ...candidate, path: ['records', 1, 'material'], reason: 'quote_not_in_source', item: null }],
  competitors: [{ path: ['records', 2, 'material'], outcome: 'unresolved', chosen: null,
    candidates: [{ value: 'Holz', spans: [span], window: 0 }, { value: 'Stein', spans: [span], window: 1 }] }],
  items: [{ path: ['records', 0, 'finds'], observed: 3, resolved: 1, partial: 2 }],
  document: { status: 'unverified', applicable: true, candidates: [], conflicts: [{ path: ['title'], candidates: ['A', 'B'] }] },
  contextOmitted: [{ ...span, stage: 'entry', record: 0, kind: 'heading' }],
})

it('shows raw GLiFormer predictions and native scores without treating decoder scores as accuracy', () => {
  const data = unifiedDiagnosticsSchema.parse({ ...unified, nativeFields: { backend: 'gliformer', windows: [{
    entry: 'p1_s0@0', record_start: 0, record_count: 2, ranges: [span], input_text: '200. Male with goatskin.',
    input_tokens: 42, identity: { revision: 'pinned', threshold: '0.05' },
    output: { record: [{ grave_id: '200', sex: null }, { sex: 'Baby' }] },
    diagnostics: { raw_score: null, effective_score: 1, span_score: 0.123456 },
  }] } })
  render(<CatalogReview unified={data} />)
  expect(screen.getByText(/GLiFormer predictions are raw and unverified/)).toBeInTheDocument()
  expect(screen.getByText(/A decoder effective score is not a learned confidence score/)).toBeInTheDocument()
  expect(screen.getByText('200. Male with goatskin.')).toBeInTheDocument()
  expect(screen.getByText(/"raw_score": null/)).toBeInTheDocument()
  expect(screen.getByText(/"sex": "Baby"/)).toBeInTheDocument()
})

it('keeps accounting, processing and evidence apart and names what is unresolved', () => {
  render(<CatalogReview unified={unified} />)
  const review = screen.getByRole('region', { name: 'Catalog review' })
  expect(review).toHaveTextContent('1 source range could not be assigned to an entry.')
  expect(review).toHaveTextContent('Not processed: 1 discovery window; values may be missing.')
  expect(review).toHaveTextContent('Some values stay proposals or conflicts.')
  expect(review).toHaveTextContent('Recall is not measured.')
  expect(review).toHaveTextContent('Catalog · 3 entries found')
  expect(review).toHaveTextContent('1 field disagreed and is left empty')
  expect(review).not.toHaveTextContent('%')
  fireEvent.click(within(review).getByText('1 proposed value not accepted'))
  expect(review).toHaveTextContent('Entry 1 · finds.?.name: Nadel (a list item seen only in part at a window cut)')
  fireEvent.click(within(review).getByText('1 list with uncertain items'))
  expect(review).toHaveTextContent('finds in entry 1: 1 placed, 2 seen only in part (3 observed)')
  fireEvent.click(within(review).getByText('1 unresolved conflict'))
  expect(review).toHaveTextContent('material: "Holz" or "Stein"')
})

it('shows an entry the supplied source ends inside as settled, apart from entries with an uncertain end', () => {
  const excerpt = unifiedDiagnosticsSchema.parse({ ...unified, unsettledEntries: [],
    sourceEndEntries: [{ id: 'p6_s3@0', label: 'Grav 31' }] })
  render(<CatalogReview unified={excerpt} />)
  const review = screen.getByRole('region', { name: 'Catalog review' })
  expect(within(review).queryByText(/uncertain end/)).toBeNull()
  fireEvent.click(within(review).getByText('1 entry cut by the end of the supplied source'))
  expect(review).toHaveTextContent('Grav 31: its text continues past the last page supplied')
})

it('reads diagnostics settled before entries cut by the source end were reported', () => {
  expect(unifiedDiagnosticsSchema.parse(unified).sourceEndEntries).toBeUndefined()
})

it('says a fully linked Catalog is verifier-supported, never verified', () => {
  const linked = unifiedDiagnosticsSchema.parse({ ...unified, completeness: { ...unified.completeness, evidence: true } })
  render(<CatalogReview unified={linked} />)
  const review = screen.getByRole('region', { name: 'Catalog review' })
  expect(review).toHaveTextContent('Every accepted value was verifier-supported.')
  expect(review).not.toHaveTextContent(/was verified/)
})
