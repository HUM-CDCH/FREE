// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { partialFromProgress } from 'extraction'
import progressFixture from '../../parsing_service/tests/fixtures/contracts/extract.progress.json'
import type { SchemaNode } from 'extraction/schema'
import { partialResultSchema, type PartialRecord, type PartialResult } from '../shared/extraction.contract'
import PartialResults from './PartialResults'

afterEach(cleanup)

const schemaNodes: SchemaNode[] = [
  { id: 'l', name: 'label', type: 'string' }, { id: 's', name: 'site', type: 'string' },
  { id: 'm', name: 'material', type: 'string' }, { id: 'g', name: 'gilded', type: 'boolean' },
  { id: 'f', name: 'finds', type: 'array', children: [{ id: 'fn', name: 'name', type: 'string' }, { id: 'fc', name: 'count', type: 'integer' }] },
  { id: 't', name: 'title', type: 'string', valueSource: 'document' },
]
const partial = (): PartialResult => partialResultSchema.parse(partialFromProgress(progressFixture))
const items = () => within(screen.getByRole('list', { name: 'Records being read' })).getAllByRole('listitem')
const withRecord = (record: PartialRecord): PartialResult => partialResultSchema.parse({ ...partial(), records: [record] })

describe('PartialResults', () => {
  it('reports progress and keeps the server record order and headers', () => {
    const serverPartial = partial()
    serverPartial.records.reverse()
    render(<PartialResults partial={serverPartial} schemaNodes={schemaNodes} />)
    expect(screen.getByRole('status')).toHaveTextContent('Reading records · 2 of 5 · from page 1')
    expect(screen.getByRole('progressbar', { name: 'Records read' })).toHaveAttribute('aria-valuenow', '40')
    expect(items().map((item) => item.getAttribute('data-record-state'))).toEqual(['queued', 'reading', 'checking', 'finished', 'finished'])
    expect(items().map((item) => item.getAttribute('aria-label'))).toEqual(['Record 5', '4', '3', '2', '1'])
    expect(items()[0]).toHaveTextContent('· page 4')
    expect(items()[4]).toHaveTextContent('· page 1')
  })

  it('shows grounded Evidence, labelled candidates, authoritative missing values and disagreements without review controls', () => {
    const onSelectEvidence = vi.fn()
    render(<PartialResults partial={partial()} schemaNodes={schemaNodes} onSelectEvidence={onSelectEvidence} />)
    const [first, second, third] = items()
    expect(within(first!).getByText('Holz')).toBeInTheDocument()
    fireEvent.click(within(first!).getByRole('button', { name: 'View Evidence for material' }))
    expect(onSelectEvidence).toHaveBeenCalledWith('a_p1_s0')
    expect(within(first!).getByText('Missing')).toBeInTheDocument()
    expect(within(second!).getByText('Contested')).toBeInTheDocument()
    expect(within(second!).getByText(/Bdorf · Bdorf-Nord/)).toBeInTheDocument()
    expect(within(third!).getAllByTitle('Candidate · being verified').map((element) => element.textContent)).toEqual(['3', 'Gold'])
    expect(within(third!).queryByRole('button', { name: /View Evidence/ })).not.toBeInTheDocument()
    expect(within(third!).getAllByText('Missing')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /^(Approve|Edit|Reject) / })).not.toBeInTheDocument()
  })

  it('uses pinned record-level placeholders while reading and only a header while queued', () => {
    render(<PartialResults partial={partial()} schemaNodes={schemaNodes} />)
    const [, , , reading, queued] = items()
    expect(within(reading!).getAllByLabelText('Reading')).toHaveLength(5)
    expect(within(reading!).queryByText('Missing')).not.toBeInTheDocument()
    expect(within(reading!).queryByText('title')).not.toBeInTheDocument()
    expect(within(queued!).queryAllByRole('img')).toHaveLength(0)
    expect(within(queued!).queryByText('label')).not.toBeInTheDocument()
  })

  it('keeps returned fields when the pinned schema no longer names them', () => {
    render(<PartialResults partial={partial()} schemaNodes={[{ id: 'x', name: 'renamed', type: 'string' }]} />)
    expect(within(items()[0]!).getByText('material')).toBeInTheDocument()
    expect(within(items()[0]!).queryByText('renamed')).not.toBeInTheDocument()
  })

  it.each(['reading', 'candidates'] as const)('describes empty container shape without inferring absence on a failed %s payload', (stage) => {
    const converted = partialResultSchema.parse(partialFromProgress({
      ...progressFixture,
      entries: [{ ...progressFixture.entries[2], stage, failed: 1, record: { details: {}, finds: [] } }],
    }))
    // Part A supplies no leaf states for empty containers, even when a values call failed.
    expect(converted.records[0]!.values).toEqual({})
    render(<PartialResults partial={converted} />)
    expect(screen.getByRole('button', { name: /details\s*0 fields/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /finds\s*0 items/ })).toBeInTheDocument()
    expect(screen.queryByText('Missing')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /details\s*0 fields/ }))
    fireEvent.click(screen.getByRole('button', { name: /finds\s*0 items/ }))
    expect(screen.getByText('No fields returned.')).toBeInTheDocument()
    expect(screen.getByText('No items returned.')).toBeInTheDocument()
    expect(screen.queryByText('Missing')).not.toBeInTheDocument()
  })

  it.each(['reading', 'checking', 'finished'] as const)('hides text with missing leaf metadata on a %s record despite Evidence', (state) => {
    const record = partial().records[0]!
    record.state = state
    record.record = { material: 'Unverified raw text', nested: { name: 'Hidden nested text' } }
    record.values = {}
    render(<PartialResults partial={withRecord(record)} onSelectEvidence={vi.fn()} />)
    const placeholderLabel = state === 'reading' ? 'Reading' : 'Queued'
    expect(screen.getByLabelText(placeholderLabel)).toBeInTheDocument()
    expect(screen.queryByText('Unverified raw text')).not.toBeInTheDocument()
    expect(screen.queryByText('Hidden nested text')).not.toBeInTheDocument()
    expect(screen.queryByText('Missing')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /View Evidence/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'nested' }))
    expect(screen.getAllByLabelText(placeholderLabel)).toHaveLength(2)
    expect(screen.queryByText('Hidden nested text')).not.toBeInTheDocument()
  })

  it('uses authoritative leaf values and states even when the raw record and Evidence disagree', () => {
    const record = partial().records[0]!
    record.record = { material: 'Stale raw value', site: 'Stale candidate', reading: 'Hidden reading', empty: 'False absence', conflict: 'Wrong winner' }
    record.values = {
      '["material"]': { value: 'Server verified value', state: 'grounded' },
      '["site"]': { value: 'Server candidate', state: 'checking' },
      '["reading"]': { value: 'Hidden reading', state: 'reading' },
      '["empty"]': { value: 'False absence', state: 'empty' },
      '["conflict"]': { value: 'Wrong winner', state: 'contested', candidates: ['A', 'B'] },
    }
    render(<PartialResults partial={withRecord(record)} onSelectEvidence={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'View Evidence for material' })).toHaveTextContent('Server verified value')
    expect(screen.getByTitle('Candidate · being verified')).toHaveTextContent('Server candidate')
    expect(screen.queryByRole('button', { name: 'View Evidence for site' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Reading')).toBeInTheDocument()
    expect(screen.getByText('Missing')).toBeInTheDocument()
    expect(screen.getByText('Contested')).toBeInTheDocument()
    expect(screen.getByText('A · B')).toBeInTheDocument()
    for (const hidden of ['Stale raw value', 'Stale candidate', 'Hidden reading', 'False absence', 'Wrong winner']) {
      expect(screen.queryByText(hidden)).not.toBeInTheDocument()
    }
  })

  it.each([
    { state: 'checking' as const, value: null }, { state: 'checking' as const, value: '' },
    { state: 'grounded' as const, value: null }, { state: 'grounded' as const, value: '' },
  ])('preserves supplied $state presentation for schema-valid blank text ($value)', ({ state, value }) => {
    const record = partial().records[0]!
    record.record = { material: value }
    record.values = { '["material"]': { state, value } }
    const onSelectEvidence = vi.fn()
    // These defensive shapes pass the wire schema even though today's Part A publisher excludes them.
    render(<PartialResults partial={withRecord(record)} onSelectEvidence={onSelectEvidence} />)
    expect(screen.getByText('No value text supplied.')).toBeInTheDocument()
    expect(screen.queryByText('Missing')).not.toBeInTheDocument()
    if (state === 'checking') {
      expect(screen.getByTitle('Candidate · being verified')).toHaveTextContent('No value text supplied.')
      expect(screen.queryByRole('button', { name: /View Evidence/ })).not.toBeInTheDocument()
    } else {
      const evidence = screen.getByRole('button', { name: 'View Evidence for material' })
      expect(evidence).toHaveTextContent('No value text supplied.')
      fireEvent.click(evidence)
      expect(onSelectEvidence).toHaveBeenCalledWith('a_p1_s0')
    }
  })

  it('keeps nested candidates out of collapsed previews and labels them after expanding objects and array items', () => {
    const record = partial().records[0]!
    record.record = { nested: { candidate: 'Raw nested candidate' }, finds: [{ name: 'Raw item candidate', verified: 'Raw verified value' }] }
    record.values = {
      '["nested","candidate"]': { value: 'Nested candidate', state: 'checking' },
      '["finds","0","name"]': { value: 'Item candidate', state: 'checking' },
      '["finds","0","verified"]': { value: 'Verified preview', state: 'grounded' },
    }
    render(<PartialResults partial={withRecord(record)} />)
    expect(screen.queryByText('Nested candidate')).not.toBeInTheDocument()
    expect(screen.queryByText('Item candidate')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'nested' }))
    expect(screen.getByTitle('Candidate · being verified')).toHaveTextContent('Nested candidate')
    fireEvent.click(screen.getByRole('button', { name: /finds\s*1 item/ }))
    expect(screen.getByRole('button', { name: /Find 1\s*Verified preview/ })).toBeInTheDocument()
    expect(screen.queryByText('Item candidate')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Find 1\s*Verified preview/ }))
    expect(screen.getAllByTitle('Candidate · being verified').map((element) => element.textContent)).toEqual(['Nested candidate', 'Item candidate'])
    for (const hidden of ['Raw nested candidate', 'Raw item candidate', 'Raw verified value']) {
      expect(screen.queryByText(hidden)).not.toBeInTheDocument()
    }
  })
})
