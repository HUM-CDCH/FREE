// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { describe, expect, it, vi } from 'vitest'
import type { ParsedDocument } from 'extraction/parsed-document'
import DocumentMarkdown from './DocumentMarkdown'
import MarkPopover from './MarkPopover'

const markdown = '# Grav 8\n\nØrsted: NØ-SV orienteret.'
const bytes = (text: string) => new TextEncoder().encode(text).length
const start = bytes('# Grav 8\n\nØrsted: ')
const document = { evidence_index: { anchors: [{ kind: 'text', anchor_id: 'a1', markdown_span: { start, end: start + bytes('NØ-SV') } }] } } as unknown as ParsedDocument
const key = JSON.stringify(['records', 0, 'orientation'])
const describe_ = new Map([[key, { name: 'orientation', value: 'NØ-SV', word: null, style: 'link' as const, anchorId: 'a1' }]])

describe('the Markdown view (results review redesign §7.4)', () => {
  it('marks a value at its anchor\'s byte span, past multi-byte text, and selects it', () => {
    const onSelect = vi.fn()
    render(<DocumentMarkdown markdown={markdown} document={document} marks={{ describe: describe_, selected: key, onSelect }} />)
    const mark = screen.getByRole('button', { name: 'orientation: NØ-SV' })
    expect(mark).toHaveTextContent(/^NØ-SV$/)
    expect(mark).toHaveAttribute('aria-current', 'true')
    expect(screen.getByLabelText('Parsed Markdown')).toHaveTextContent('# Grav 8 Ørsted: NØ-SV orienteret.')
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
    const two = new Map([...describe_, [JSON.stringify(['records', 0, 'site']), { name: 'site', value: 'Ellekilde', word: null, style: 'link' as const, anchorId: 'a1' }]])
    const onChoose = vi.fn()
    const onClose = vi.fn()
    const { unmount } = render(<MarkPopover keys={[...two.keys()]} describe={two} mark={mark} onChoose={onChoose} onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: 'Values in this passage' })
    expect(window.document.activeElement).toBe(screen.getByRole('button', { name: 'orientation · NØ-SV' }))
    fireEvent.click(screen.getByRole('button', { name: 'site · Ellekilde' }))
    expect(onChoose).toHaveBeenCalledWith(JSON.stringify(['records', 0, 'site']))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    unmount()
    expect(window.document.activeElement).toBe(mark)
  })
})
