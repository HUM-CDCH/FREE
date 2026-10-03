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
