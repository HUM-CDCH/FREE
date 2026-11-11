// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ParsedDocument } from 'extraction/parsed-document'
import DocumentMarkdown from './DocumentMarkdown'
import { useLayoutEffect, useState, type ComponentProps } from 'react'
import { createSelectionChannel, type SelectionChannel } from './selectionChannel'
import type { RailMarkState, MarkInfo } from './useEvidenceOverlays'

afterEach(cleanup)

const markdown = '# Unit 7\n\nCafé wall: NE–SW aligned.'
const bytes = (text: string) => new TextEncoder().encode(text).length
const start = bytes('# Unit 7\n\nCafé wall: ')
const document = { evidence_index: { anchors: [{ kind: 'text', anchor_id: 'a1', markdown_span: { start, end: start + bytes('NE–SW') } }] } } as unknown as ParsedDocument
const key = JSON.stringify(['records', 0, 'orientation'])
const describe_ = new Map([[key, { name: 'orientation', value: 'NE–SW', word: null, style: 'link' as const, anchorId: 'a1' }]])

const ignoreSelection = () => {}
// All passages in this fixture share a1. Publish real saved links rather than making descriptions own geometry.
function TestMarkdown({ marks, channel, ...props }: Pick<ComponentProps<typeof DocumentMarkdown>, 'markdown' | 'document' | 'marksShown'> & {
  marks: (Omit<RailMarkState, 'savedLinks'> & { savedLinks?: RailMarkState['savedLinks']; onSelect: (keys: string[], element: HTMLElement) => void }) | null
  channel?: SelectionChannel
}) {
  const [ownChannel] = useState(createSelectionChannel)
  const selection = channel ?? ownChannel
  useLayoutEffect(() => {
    selection.publish({ marks: marks && { ...marks, extractionId: 'markdown', savedLinks: marks.savedLinks
      ?? [...marks.describe.keys()].map(key => ({ key, link: { resultPath: ['field'], evidenceAnchorId: 'a1' } })) } })
  }, [selection, marks])
  return <DocumentMarkdown {...props} selection={selection} extractionId="markdown" onSelect={marks?.onSelect ?? ignoreSelection} />
}

describe('the Markdown view', () => {
  it('marks a value at its anchor\'s byte span, past multi-byte text, and selects it', () => {
    const onSelect = vi.fn()
    render(<TestMarkdown markdown={markdown} document={document} marks={{ describe: describe_, selected: key, onSelect }} />)
    const mark = screen.getByRole('button', { name: 'orientation: NE–SW' })
    expect(mark).toHaveTextContent(/^NE–SW$/)
    expect(mark).toHaveAttribute('aria-current', 'true')
    expect(mark).toHaveAttribute('data-evidence-anchor-id', 'a1')
    expect(screen.getByLabelText('Parsed Markdown')).toHaveTextContent('# Unit 7 Café wall: NE–SW aligned.')
    fireEvent.click(mark)
    expect(onSelect).toHaveBeenCalledWith([key], mark)
  })

  it('marks a link no value describes without selecting it, and a passage it shares with a value selects the value', () => {
    const onSelect = vi.fn()
    const found = { key: 'found:0', link: { resultPath: ['records', 0], evidenceAnchorId: 'a1' } }
    const { rerender } = render(<TestMarkdown markdown={markdown} document={document} marks={{ describe: describe_, selected: null, onSelect, savedLinks: [found] }} />)
    expect(screen.getByText('NE–SW')).toHaveClass('evidence-mark')
    expect(screen.queryByRole('button')).toBeNull()
    const value = { key, link: { resultPath: ['records', 0, 'orientation'], evidenceAnchorId: 'a1' } }
    rerender(<TestMarkdown markdown={markdown} document={document} marks={{ describe: describe_, selected: null, onSelect, savedLinks: [value, found] }} />)
    const mark = screen.getByRole('button', { name: 'orientation: NE–SW' })
    fireEvent.click(mark)
    expect(onSelect).toHaveBeenCalledWith([key], mark)
  })

  it('labels an early text match as an unverified preview and lets it select its saved value',()=>{
    const onSelect=vi.fn()
    const preview=new Map([[key,{...describe_.get(key)!,name:'orientation (preview, not verified)',style:'preview' as const}]])
    render(<TestMarkdown markdown={markdown} document={document} marks={{describe:preview,selected:null,onSelect}}/>)
    const mark=screen.getByRole('button',{name:'orientation (preview, not verified): NE–SW'})
    expect(mark).toHaveClass('preview')
    expect(mark).not.toHaveClass('decided')
    fireEvent.click(mark)
    expect(onSelect).toHaveBeenCalledWith([key],mark)
  })

  it('keeps a shared passage provisional until every highlighted value is verified', () => {
    const previewKey = 'preview'
    const marks = { describe: new Map<string, MarkInfo>([...describe_, [previewKey, {
      ...describe_.get(key)!, name: 'axis (preview, not verified)', style: 'preview' as const,
    }]]), selected: null, onSelect: vi.fn() }
    const { rerender } = render(<TestMarkdown markdown={markdown} document={document} marks={marks} />)
    expect(screen.getByRole('button', { name: /orientation: NE–SW; axis \(preview, not verified\)/ }).classList.contains('preview')).toBe(true)
    const verified = new Map(marks.describe).set(previewKey, { ...describe_.get(key)!, name: 'axis' })
    rerender(<TestMarkdown markdown={markdown} document={document} marks={{ ...marks, describe: verified }} />)
    expect(screen.getByRole('button', { name: 'orientation: NE–SW; axis: NE–SW' })).toHaveClass('link')
  })

  it('says when there is no Markdown', () => {
    render(<TestMarkdown markdown={null} document={null} marks={null} />)
    expect(screen.getByText('Markdown unavailable')).toBeInTheDocument()
  })
})

describe('the values in one passage', () => {
  it('names a value once when its model and correction Evidence share the passage, lit while one of its parts is chosen', () => {
    const edited = { name: 'orientation', value: 'N–S', word: 'Edited', style: 'link' as const, anchorId: 'a1' }
    const link = { resultPath: ['records', 0, 'orientation'], evidenceAnchorId: 'a1' }
    render(<TestMarkdown markdown={markdown} document={document} marks={{ describe: new Map([['v', edited], ['v#correction', edited]]),
      selected: 'v#["records",0,"orientation","x"]', onSelect: vi.fn(), savedLinks: [{ key: 'v', link }, { key: 'v#correction', link, occurrenceIds: ['o1'] }] }} />)
    expect(screen.getByRole('button', { name: 'orientation: N–S, Edited' })).toHaveAttribute('aria-current', 'true')
  })

  it('names two values that read alike in one passage, from two records, twice', () => {
    const harlow = { name: 'place', value: 'Harlow', word: null, style: 'link' as const, anchorId: 'a1' }
    render(<TestMarkdown markdown={markdown} document={document} marks={{ describe: new Map([['v', harlow], ['w', harlow]]), selected: null, onSelect: vi.fn() }} />)
    expect(screen.getByRole('button', { name: 'place: Harlow; place: Harlow' })).toBeInTheDocument()
  })

  it('selects all linked fields directly from their shared mark', () => {
    const two = new Map([...describe_, [JSON.stringify(['records', 0, 'site']), { name: 'site', value: 'Elmbrooke', word: null, style: 'link' as const, anchorId: 'a1' }]])
    const onSelect = vi.fn()
    render(<TestMarkdown markdown={markdown} document={document} marks={{ describe: two, selected: null, onSelect }} />)
    const mark = screen.getByRole('button', { name: 'orientation: NE–SW; site: Elmbrooke' })
    fireEvent.click(mark)
    expect(onSelect).toHaveBeenCalledWith([...two.keys()], mark)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('names its values under the pointer, and is lit while one of them is hovered in Results', () => {
    const channel = createSelectionChannel(), onHover = vi.spyOn(channel, 'hover')
    render(<TestMarkdown channel={channel} markdown={markdown} document={document} marks={{ describe: describe_, selected: null, onSelect: vi.fn() }} />)
    const mark = screen.getByRole('button', { name: 'orientation: NE–SW' })
    expect(mark).not.toHaveClass('hovered')
    expect(mark).not.toHaveAttribute('title')
    expect(mark).toHaveAttribute('data-name', 'orientation')
    // The pointer's own movement lights it; a mark that scrolls in under a still pointer gets only `mouseenter`.
    fireEvent.mouseEnter(mark)
    expect(onHover).not.toHaveBeenCalled()
    fireEvent.mouseMove(mark)
    expect(onHover).toHaveBeenLastCalledWith([key])
    fireEvent.mouseLeave(mark)
    expect(onHover).toHaveBeenLastCalledWith(null)
    act(() => channel.hover([key]))
    expect(mark).toHaveClass('hovered')
  })
})

describe('mark visibility preserves the Markdown source', () => {
  it('leaves unselected source text readable when marks are off', () => {
    render(<TestMarkdown markdown={markdown} document={document} marks={{ describe: describe_, selected: null, onSelect: vi.fn() }} marksShown={false} />)
    expect(screen.getByLabelText('Parsed Markdown').textContent).toBe(markdown)
    expect(screen.queryByRole('button', { name: 'orientation: NE–SW' })).toBeNull()
  })
  it('keeps the selected mark when marks are off', () => {
    render(<TestMarkdown markdown={markdown} document={document} marks={{ describe: describe_, selected: key, onSelect: vi.fn() }} marksShown={false} />)
    expect(screen.getByRole('button', { name: 'orientation: NE–SW' })).toHaveAttribute('aria-current', 'true')
  })
  it('never marks a page-only link as a precise passage', () => {
    const describe = new Map([[key, { ...describe_.get(key)!, precision: 'input' as const }]])
    render(<TestMarkdown markdown={markdown} document={document} marks={{ describe, selected: key, onSelect: vi.fn(), savedLinks: [{ key, link: { resultPath: ['field'], evidenceAnchorId: 'a1', precision: 'input' } }] }} />)
    expect(screen.getByLabelText('Parsed Markdown').textContent).toBe(markdown)
    expect(screen.queryByRole('button', { name: 'orientation: NE–SW' })).toBeNull()
  })
})
