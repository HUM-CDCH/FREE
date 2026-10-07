// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ParsedDocument } from 'extraction/parsed-document'
import DocumentMarkdown from './DocumentMarkdown'
import MarkPopover from './MarkPopover'

afterEach(cleanup)

const markdown = '# Unit 7\n\nCafé wall: NE–SW aligned.'
const bytes = (text: string) => new TextEncoder().encode(text).length
const start = bytes('# Unit 7\n\nCafé wall: ')
const document = { evidence_index: { anchors: [{ kind: 'text', anchor_id: 'a1', markdown_span: { start, end: start + bytes('NE–SW') } }] } } as unknown as ParsedDocument
const key = JSON.stringify(['records', 0, 'orientation'])
const describe_ = new Map([[key, { name: 'orientation', value: 'NE–SW', word: null, style: 'link' as const, anchorId: 'a1' }]])

describe('the Markdown view (results review redesign §7.4)', () => {
  it('marks a value at its anchor\'s byte span, past multi-byte text, and selects it', () => {
    const onSelect = vi.fn()
    render(<DocumentMarkdown markdown={markdown} document={document} marks={{ describe: describe_, selected: key, onSelect }} />)
    const mark = screen.getByRole('button', { name: 'orientation: NE–SW' })
    expect(mark).toHaveTextContent(/^NE–SW$/)
    expect(mark).toHaveAttribute('aria-current', 'true')
    expect(screen.getByLabelText('Parsed Markdown')).toHaveTextContent('# Unit 7 Café wall: NE–SW aligned.')
    fireEvent.click(mark)
    expect(onSelect).toHaveBeenCalledWith([key], mark)
  })

  it('says when there is no Markdown', () => {
    render(<DocumentMarkdown markdown={null} document={null} marks={null} />)
    expect(screen.getByText('Markdown unavailable')).toBeInTheDocument()
  })
})

describe('the values in one passage (§7.2)', () => {
  it('lists them; choosing one selects it; Escape closes and returns focus to the mark', () => {
    const mark = window.document.createElement('button')
    window.document.body.append(mark)
    const two = new Map([...describe_, [JSON.stringify(['records', 0, 'site']), { name: 'site', value: 'Elmbrooke', word: null, style: 'link' as const, anchorId: 'a1' }]])
    const onChoose = vi.fn()
    const onClose = vi.fn()
    const { unmount } = render(<MarkPopover keys={[...two.keys()]} describe={two} mark={mark} onChoose={onChoose} onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: 'Values in this passage' })
    expect(window.document.activeElement).toBe(screen.getByRole('button', { name: 'orientation · NE–SW' }))
    fireEvent.click(screen.getByRole('button', { name: 'site · Elmbrooke' }))
    expect(onChoose).toHaveBeenCalledWith(JSON.stringify(['records', 0, 'site']))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    unmount()
    expect(window.document.activeElement).toBe(mark)
  })
})

describe('mark visibility preserves the Markdown source', () => {
  it('leaves unselected source text readable when marks are off', () => {
    render(<DocumentMarkdown markdown={markdown} document={document} marks={{ describe: describe_, selected: null, onSelect: vi.fn() }} marksShown={false} />)
    expect(screen.getByLabelText('Parsed Markdown').textContent).toBe(markdown)
    expect(screen.queryByRole('button', { name: 'orientation: NE–SW' })).toBeNull()
  })
  it('keeps the selected mark when marks are off', () => {
    render(<DocumentMarkdown markdown={markdown} document={document} marks={{ describe: describe_, selected: key, onSelect: vi.fn() }} marksShown={false} />)
    expect(screen.getByRole('button', { name: 'orientation: NE–SW' })).toHaveAttribute('aria-current', 'true')
  })
  it('never marks a page-only link as a precise passage', () => {
    const describe = new Map([[key, { ...describe_.get(key)!, precision: 'input' as const }]])
    render(<DocumentMarkdown markdown={markdown} document={document} marks={{ describe, selected: key, onSelect: vi.fn() }} />)
    expect(screen.getByLabelText('Parsed Markdown').textContent).toBe(markdown)
    expect(screen.queryByRole('button', { name: 'orientation: NE–SW' })).toBeNull()
  })
})
