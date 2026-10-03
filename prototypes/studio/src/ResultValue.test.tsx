// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ResultValue, { RecordHeader, type ValueState } from './ui/ResultValue'

afterEach(cleanup)

describe('ResultValue', () => {
  it.each([
    { kind: 'object', value: { title: 'Anna' } },
    { kind: 'array', value: [{ title: 'Anna' }] },
  ])('exposes $kind navigation as a focusable native button', ({ value }) => {
    const onNavigateTo = vi.fn()
    render(<ResultValue name="People" value={value} path={['records', '0', 'people']} defaultExpanded={false} onNavigateTo={onNavigateTo} />)

    const button = screen.getByRole('button', { name: /^People/ })
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAttribute('type', 'button')
    expect(button).not.toHaveAttribute('aria-expanded')
    button.focus()
    expect(button).toHaveFocus()
    fireEvent.click(button)
    expect(onNavigateTo).toHaveBeenCalledExactlyOnceWith(['records', '0', 'people'])
  })

  it.each([
    { kind: 'object', value: { title: 'Anna' } },
    { kind: 'array', value: ['Anna'] },
  ])('keeps inline $kind disclosure accessible', ({ value }) => {
    render(<ResultValue name="People" value={value} defaultExpanded={false} />)

    const button = screen.getByRole('button', { name: /^People/ })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByText('Anna').length).toBeGreaterThan(0)
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })

  it('marks null and empty values as missing', () => {
    const html = renderToStaticMarkup(<ResultValue name="Root" value={{ title: '', date: null }} />)

    expect(html).toContain('Missing')
    expect(html.match(/Missing/g)?.length).toBe(2)
  })

  it('renders arrays as expandable item lists', () => {
    const html = renderToStaticMarkup(<ResultValue name="People" value={[{ name: 'Anna' }]} />)

    expect(html).toContain('1 item')
    expect(html).toContain('Person 1')
    expect(html).toContain('Anna')
  })
})

describe('value states (redesign §8)', () => {
  const states = (state: ValueState) => ({ getValueState: () => state })
  it('reading shows a placeholder and never text', () => {
    render(<ResultValue name="title" value="not yet" path={['title']} {...states('reading')} />)
    expect(screen.queryByText('not yet')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Reading')).toBeInTheDocument()
  })
  it('checking shows the candidate muted with a hollow marker', () => {
    render(<ResultValue name="title" value="Candidate" path={['title']} {...states('checking')} />)
    const value = screen.getByText('Candidate')
    expect(value.closest('[title]')!.className).toMatch(/text-ink-muted/)
    expect(screen.getByTitle('Candidate · being verified')).toBeInTheDocument()
    cleanup()
    // Inside a record every leaf renders in full (expandText); a candidate there carries the same marker.
    render(<ResultValue name="Record 1" value={{ title: 'Nested candidate' }} path={['records', '0']} expandText {...states('checking')} />)
    const nested = screen.getByText('Nested candidate')
    expect(nested.closest('[title="Candidate · being verified"]')!.className).toMatch(/text-ink-muted/)
    expect(screen.getByTitle('Candidate · being verified')).toBeInTheDocument()
  })
  it('an expanded checking value keeps its candidate marker', () => {
    // jsdom lays nothing out: report the clamped value as overflowing so the row offers "More".
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(80)
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40)
    try {
      render(<ResultValue name="title" value="A long candidate" path={['title']} {...states('checking')} />)
      fireEvent.click(screen.getByRole('button', { name: 'More' }))
      expect(screen.getByRole('button', { name: 'Less' })).toBeInTheDocument()
      const value = screen.getByText('A long candidate')
      expect(value.closest('[title="Candidate · being verified"]')!.className).toMatch(/text-ink-muted/)
      expect(value.className).not.toMatch(/line-clamp-2/)
    } finally {
      scrollHeight.mockRestore()
      clientHeight.mockRestore()
    }
  })
  it('asks for each leaf\'s state by its own full path', () => {
    const getValueState = vi.fn((path: string[]) => JSON.stringify(path) === JSON.stringify(['a', 'b', 'c']) ? 'reading' as const : undefined)
    render(<ResultValue name="a" value={{ b: { c: 'hidden while reading', d: 'shown' } }} path={['a']} getValueState={getValueState} />)
    expect(getValueState).toHaveBeenCalledWith(['a', 'b', 'c'])
    expect(getValueState).toHaveBeenCalledWith(['a', 'b', 'd'])
    expect(screen.getByLabelText('Reading')).toBeInTheDocument()
    expect(screen.queryByText('hidden while reading')).not.toBeInTheDocument()
    expect(screen.getByText('shown')).toBeInTheDocument()
  })
  it('queued shows a line marker and the name only', () => {
    render(<ResultValue name="title" value={null} path={['title']} {...states('queued')} />)
    expect(screen.getByLabelText('Queued')).toBeInTheDocument()
    expect(screen.queryByText('Missing')).not.toBeInTheDocument()
  })
  it('grounded, empty and contested render as before', () => {
    render(<ResultValue name="title" value="Report" path={['title']} {...states('grounded')} getEvidenceAnchorId={() => 'a1'} onSelectEvidence={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'View Evidence for title' })).toBeInTheDocument()
    cleanup()
    render(<ResultValue name="title" value={null} path={['title']} {...states('empty')} />)
    expect(screen.getByText('Missing')).toBeInTheDocument()
    cleanup()
    render(<ResultValue name="title" value={null} path={['title']} {...states('contested')} getContested={() => ['a', 'b']} />)
    expect(screen.getByText('Contested')).toBeInTheDocument()
  })
  it('a record header names the record and its page', () => {
    render(<RecordHeader label="Record 3" page={6} />)
    expect(screen.getByText('Record 3')).toBeInTheDocument()
    expect(screen.getByText('· page 6')).toBeInTheDocument()
  })
})

// Decision 14: rows without pills. The value is its own way to its Evidence; "to check" is a marker before it.
describe('results rows without pills (decision 14)', () => {
  const grounded = { getValueState: () => 'grounded' as const, getEvidenceAnchorId: () => 'a1' }
  const decision = (action: 'APPROVED' | 'EDITED' | 'REJECTED' = 'APPROVED') => ({
    resultPath: ['title'], evidenceAnchorId: 'a1', reviewedOccurrenceIds: [], action,
    reviewedValue: action === 'EDITED' ? 'Reviewed report' : null,
  })
  const review = (touched: boolean, action: 'APPROVED' | 'EDITED' | 'REJECTED' = 'APPROVED') => ({
    getDecision: () => decision(action), getSchemaNode: () => null, isTouched: () => touched, onDecision: vi.fn(),
  })

  it.each([
    ['a row', false],
    ['an expanded row', true],
  ])('in %s, a grounded value is the button to its Evidence, named for the field and described by the value', (_label, expandText) => {
    const onSelectEvidence = vi.fn()
    render(<ResultValue name="title" value="Report" path={['title']} expandText={expandText} {...grounded} onSelectEvidence={onSelectEvidence} />)
    const link = screen.getByRole('button', { name: 'View Evidence for title' })
    expect(link.tagName).toBe('BUTTON')
    expect(link).toHaveTextContent('Report')
    expect(link).toHaveAccessibleDescription('Report')
    expect(screen.queryByText('Evidence')).not.toBeInTheDocument()
    link.focus()
    expect(link).toHaveFocus()
    fireEvent.click(link)
    expect(onSelectEvidence).toHaveBeenCalledExactlyOnceWith('a1')
    // At least 24px tall (§10).
    expect(link.className).toMatch(/(^|\s)min-h-6(\s|$)/)
  })

  it('after an edit the value still leads to the extracted value\'s Evidence', () => {
    render(<ResultValue name="title" value="Reviewed report" path={['title']} {...grounded} onSelectEvidence={vi.fn()} review={review(true, 'EDITED')} />)
    expect(screen.getByRole('button', { name: 'View Evidence for extracted value of title' })).toHaveTextContent('Reviewed report')
  })

  it('grounding\'s doubt is a quiet note under the value, never a Check pill', () => {
    render(<ResultValue name="title" value="Report" path={['title']} {...grounded} onSelectEvidence={vi.fn()}
      getEvidenceCheck={() => 'Value also appears in 2 other passages'} />)
    const note = screen.getByRole('note', { name: 'Value also appears in 2 other passages' })
    expect(note).toHaveTextContent('Value also appears in 2 other passages')
    expect(note.className).not.toMatch(/rounded-full/)
    expect(screen.queryByText('Check')).not.toBeInTheDocument()
  })

  it.each([
    ['a row', false],
    ['an expanded row', true],
  ])('in %s, a value still to check carries an accent marker before it and keeps its decision controls', (_label, expandText) => {
    render(<ResultValue name="title" value="Report" path={['title']} expandText={expandText} {...grounded} onSelectEvidence={vi.fn()} review={review(false)} />)
    const marker = screen.getByRole('img', { name: 'to check' })
    expect(marker).toHaveAttribute('title', 'To check')
    // A small filled accent dot, unlike the hollow §8 "checking" marker.
    expect(marker.className).toMatch(/(^|\s)size-2(\s|$)/)
    expect(marker.className).toMatch(/(^|\s)rounded-full(\s|$)/)
    expect(marker.className).toMatch(/(^|\s)bg-accent(\s|$)/)
    expect(marker.className).not.toMatch(/(^|\s)border(-|\s|$)/)
    // Before the value: the marker precedes the value's button in the document.
    expect(marker.compareDocumentPosition(screen.getByRole('button', { name: 'View Evidence for title' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // One marker, not a second hollow "Pending review" ring as well.
    expect(screen.queryByTitle('Pending review')).not.toBeInTheDocument()
    for (const name of ['Approve title', 'Edit title', 'Reject title'])
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
  })

  it.each(['APPROVED', 'EDITED', 'REJECTED'] as const)('a decided (%s) row shows no to-check marker', (action) => {
    render(<ResultValue name="title" value="Report" path={['title']} {...grounded} onSelectEvidence={vi.fn()} review={review(true, action)} />)
    expect(screen.queryByRole('img', { name: 'to check' })).not.toBeInTheDocument()
  })

  it('an ungrounded value is plain text with its verifier note, not a button', () => {
    render(<ResultValue name="place" value="Ravenna" path={['place']} getValueState={() => undefined} onSelectEvidence={vi.fn()}
      getClaimStatus={() => ({ label: 'Unsupported', detail: 'No passage supports this value.' })} />)
    expect(screen.queryByRole('button', { name: /View Evidence/ })).not.toBeInTheDocument()
    expect(screen.getByText('Ravenna').closest('button')).toBeNull()
    expect(screen.getByRole('note', { name: 'Unsupported: No passage supports this value.' })).toHaveTextContent('Unsupported')
  })
})

describe('a rejected value (decision 14)', () => {
  it('shows Missing, and Missing leads to the extracted value\'s Evidence', () => {
    const onSelectEvidence = vi.fn()
    render(<ResultValue name="title" value={null} path={['title']} getValueState={() => 'grounded'} getEvidenceAnchorId={() => 'a1'}
      onSelectEvidence={onSelectEvidence} review={{ getDecision: () => ({ resultPath: ['title'], evidenceAnchorId: 'a1',
        reviewedOccurrenceIds: [], action: 'REJECTED', reviewedValue: null }), getSchemaNode: () => null, isTouched: () => true }} />)
    const link = screen.getByRole('button', { name: 'View Evidence for extracted value of title' })
    expect(link).toHaveTextContent('Missing')
    fireEvent.click(link)
    expect(onSelectEvidence).toHaveBeenCalledExactlyOnceWith('a1')
  })
})

// The server prepares an untouched decision with no Evidence anchor for every ungrounded or missing cell; those are not
// "to check" (the badge and Review attention count grounded undecided values only), so they keep their status dot.
describe('the to-check marker counts grounded values only', () => {
  const nullAnchor = (path: string[]) => ({
    getDecision: () => ({ resultPath: path, evidenceAnchorId: null, reviewedOccurrenceIds: [], action: 'APPROVED' as const, reviewedValue: null }),
    getSchemaNode: () => null, isTouched: () => false, onDecision: vi.fn(),
  })
  it.each([
    ['an ungrounded value', 'Ravenna'],
    ['a missing value', null],
  ])('%s with its untouched null-anchor decision shows no marker, only its pending status dot', (_label, value) => {
    render(<ResultValue name="place" value={value} path={['place']} getValueState={() => (value === null ? 'empty' : undefined)} review={nullAnchor(['place'])} />)
    expect(screen.queryByRole('img', { name: 'to check' })).not.toBeInTheDocument()
    expect(screen.getByTitle('Pending review')).toBeInTheDocument()
  })
  it('a grounded value with its untouched decision does show it', () => {
    render(<ResultValue name="title" value="Report" path={['title']} getValueState={() => 'grounded'} getEvidenceAnchorId={() => 'a1'} onSelectEvidence={vi.fn()}
      review={{ ...nullAnchor(['title']), getDecision: () => ({ resultPath: ['title'], evidenceAnchorId: 'a1', reviewedOccurrenceIds: [], action: 'APPROVED' as const, reviewedValue: null }) }} />)
    expect(screen.getByRole('img', { name: 'to check' })).toBeInTheDocument()
  })
})
