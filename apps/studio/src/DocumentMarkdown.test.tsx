// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ParsedDocument } from 'extraction/parsed-document'
import type { EvidenceLink } from 'extraction/durable-types'
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

  it('marks a record start discovery found without selecting it, and a passage it shares with a value selects the value', () => {
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

describe('saved table-cell evidence', () => {
  const before = 'Café 🧱\n\n', body = 'Places: Café 🧱\nPort\tRegion\nParis\tWest\nParis\tEast'
  const cellId = 'a_p2_s0_r2_c0', regionId = 'a_p2_s0_r2_c1'
  const source = { markdown: before + body, document: {
    content_stream: [{ kind: 'table', parser: 'kei-exp', block_id: 'b_p2_s0', table_id: 't_p2_s0',
      markdown_span: { start: bytes(before), end: bytes(before + body) } }],
    evidence_index: { anchors: [
      { kind: 'table_cell', anchor_id: cellId, logical_table_id: 't_p2_s0', cell_id: 'r2_c0', canonical_row: 2, canonical_column: 0 },
      { kind: 'table_cell', anchor_id: regionId, logical_table_id: 't_p2_s0', cell_id: 'r2_c1', canonical_row: 2, canonical_column: 1 },
    ] },
  } as unknown as ParsedDocument }
  const place = 'place', region = 'region'
  const describe = new Map([
    [place, { name: 'place', value: 'Paris', word: null, style: 'link' as const }],
    [region, { name: 'region', value: 'East', word: null, style: 'link' as const }],
  ])
  const start = Array.from(body.slice(0, body.lastIndexOf('Paris'))).length
  const grounding: NonNullable<EvidenceLink['grounding']> = { linkedBy: 'verification', support: 'literal',
    precision: 'cell', raw: 'Paris', textSpans: [{ segment: 'p2_s0', start, end: start + 5 }], alternatives: [], itemSpans: null }
  const link: EvidenceLink = { resultPath: ['records', 1, 'place'], evidenceAnchorId: cellId, precision: 'cell', grounding }

  it('marks saved cell offsets in their table block, keeping the cell identity and repeated rows distinct', () => {
    const onSelect = vi.fn()
    render(<TestMarkdown {...source} marks={{ describe, selected: place, onSelect, savedLinks: [
      { key: place, link }, { key: region, link: { ...link, evidenceAnchorId: regionId, grounding: { ...grounding,
        raw: 'East', textSpans: [{ segment: 'p2_s0', start: start + 6, end: start + 10 }] } } },
    ] }} />)
    const mark = screen.getByRole('button', { name: 'place: Paris' })
    expect(mark.textContent).toBe('Paris')
    expect(mark.previousSibling?.textContent).toContain('Paris\tWest\n')
    expect(mark).toHaveAttribute('data-evidence-anchor-id', cellId)
    expect(mark).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: 'region: East' }).textContent).toBe('East')
    expect(screen.getByLabelText('Parsed Markdown').textContent).toBe(source.markdown)
    fireEvent.click(mark)
    expect(onSelect).toHaveBeenCalledWith([place], mark)
  })

  it.each([
    ['missing spans', undefined],
    ['supporting evidence', { ...grounding, support: 'supporting' as const }],
    ['different raw text', { ...grounding, raw: 'Lyon' }],
    ['a foreign table', { ...grounding, textSpans: [{ segment: 'p1_s0', start, end: start + 5 }] }],
    ['out-of-range offsets', { ...grounding, textSpans: [{ segment: 'p2_s0', start, end: 999 }] }],
  ] as const)('does not guess a cell position for %s', (_, grounding) => {
    render(<TestMarkdown {...source} marks={{ describe, selected: null, onSelect: vi.fn(),
      savedLinks: [{ key: place, link: { ...link, grounding } }] }} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByLabelText('Parsed Markdown').textContent).toBe(source.markdown)
  })

  it('does not assume another producer writes raw canonical table text', () => {
    const document = { ...source.document, content_stream: source.document.content_stream.map(block => ({ ...block, parser: 'other' })) }
    render(<TestMarkdown markdown={source.markdown} document={document} marks={{ describe, selected: null, onSelect: vi.fn(),
      savedLinks: [{ key: place, link }] }} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByLabelText('Parsed Markdown').textContent).toBe(source.markdown)
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

describe('saved value spans in Markdown', () => {
  const passage = 'Café 🧭: Paris, puis Paris.'
  const anchorId = 'a_p1_s0'
  const valueKey = 'place'
  const descriptions = new Map([[valueKey, { name: 'place', value: 'Paris', word: null, style: 'link' as const }]])
  const spans = (start: number, end: number) => [{ segment: 'p1_s0', start, end }]
  const second = Array.from(passage.slice(0, passage.lastIndexOf('Paris'))).length
  const located: EvidenceLink = { resultPath: ['place'], evidenceAnchorId: anchorId,
    location: { textSpans: spans(second, second + 5), raw: 'Paris' } }
  const fixture = (kind: 'paragraph' | 'heading' | 'code' = 'paragraph') => {
    const body = kind === 'heading' ? `## ${passage}` : kind === 'code' ? `\`\`\`text\n${passage}\n\`\`\`` : passage
    const before = '# Préface\n\n'
    const span = { start: bytes(before), end: bytes(before + body) }
    return { markdown: before + body + '\n', document: {
      content_stream: [{ kind, block_id: 'b_p1_s0', text: passage, level: 2, language: 'text' }],
      evidence_index: { anchors: [{ kind: 'text', anchor_id: anchorId, block_id: 'b_p1_s0', markdown_span: span }] },
    } as unknown as ParsedDocument }
  }

  it('marks only the saved occurrence past accents and an astral character, without PDF value boxes', () => {
    const onSelect = vi.fn(), source = fixture()
    render(<TestMarkdown {...source} marks={{ describe: descriptions, selected: valueKey, onSelect, savedLinks: [{ key: valueKey, link: located }] }} />)
    const mark = screen.getByRole('button', { name: 'place: Paris' })
    expect(mark.textContent).toBe('Paris')
    expect(mark.previousSibling?.textContent).toContain('Paris, puis ')
    expect(mark).toHaveAttribute('aria-current', 'true')
    expect(screen.getByLabelText('Parsed Markdown').textContent).toBe(source.markdown)
    fireEvent.click(mark)
    expect(onSelect).toHaveBeenCalledWith([valueKey], mark)
  })

  it.each(['heading', 'code'] as const)('maps canonical offsets past a %s wrapper', kind => {
    const source = fixture(kind)
    render(<TestMarkdown {...source} marks={{ describe: descriptions, selected: null, onSelect: vi.fn(), savedLinks: [{ key: valueKey, link: located }] }} />)
    expect(screen.getByRole('button', { name: 'place: Paris' }).textContent).toBe('Paris')
    expect(screen.getByLabelText('Parsed Markdown').textContent).toBe(source.markdown)
  })

  const recipe: EvidenceLink['grounding'] = { linkedBy: 'key', provenance: 'token', textSpans: spans(second, second + 5),
    keySpans: [], alternatives: [], heading: null, precision: 'segment', raw: 'Paris', normalized: null }
  const literal: EvidenceLink['grounding'] = { linkedBy: 'verification', support: 'literal', textSpans: spans(second, second + 5),
    alternatives: [], precision: 'segment', raw: 'Paris', itemSpans: null }
  it.each([['recipe', recipe], ['verified literal', literal]] as const)('uses %s grounding spans', (_, grounding) => {
    render(<TestMarkdown {...fixture()} marks={{ describe: descriptions, selected: null, onSelect: vi.fn(),
      savedLinks: [{ key: valueKey, link: { ...located, location: undefined, grounding } }] }} />)
    expect(screen.getByRole('button', { name: 'place: Paris' }).textContent).toBe('Paris')
  })

  it.each([
    ['no location', { ...located, location: undefined }],
    ['out-of-range location', { ...located, location: { raw: 'Paris', textSpans: spans(second, 999) } }],
    ['a foreign segment', { ...located, location: { raw: 'Paris', textSpans: [{ segment: 'p2_s0', start: second, end: second + 5 }] } }],
    ['supporting evidence', { ...located, location: undefined, grounding: { ...literal, support: 'supporting' as const } }],
  ] as const)('keeps the passage for %s', (_, link) => {
    render(<TestMarkdown {...fixture()} marks={{ describe: descriptions, selected: null, onSelect: vi.fn(), savedLinks: [{ key: valueKey, link }] }} />)
    expect(screen.getByRole('button', { name: 'place: Paris' }).textContent).toBe(passage)
  })

  it('keeps the passage when its Markdown no longer matches the canonical block', () => {
    const source = fixture()
    const changed = source.markdown.replace('Café', 'Cafe')
    // Retain a valid byte span for the changed Markdown, but the original canonical text.
    const anchor = source.document.evidence_index.anchors[0]!
    if (anchor.kind === 'text') anchor.markdown_span.end--
    render(<TestMarkdown {...source} markdown={changed} marks={{ describe: descriptions, selected: null, onSelect: vi.fn(), savedLinks: [{ key: valueKey, link: located }] }} />)
    expect(screen.getByRole('button', { name: 'place: Paris' }).textContent).toBe(passage.replace('Café', 'Cafe'))
    expect(screen.getByLabelText('Parsed Markdown').textContent).toBe(changed)
  })

  it('selects distinct values in one passage separately and keeps only the selected mark when marks are hidden', () => {
    const first = 8, firstKey = 'first'
    const source = fixture(), onSelect = vi.fn()
    const describe = new Map([...descriptions, [firstKey, { ...descriptions.get(valueKey)!, name: 'first place' }]])
    const savedLinks = [{ key: firstKey, link: { ...located, location: { raw: 'Paris', textSpans: spans(first, first + 5) } } }, { key: valueKey, link: located }]
    const marks = { describe, selected: valueKey, onSelect, savedLinks }
    const { rerender } = render(<TestMarkdown {...source} marks={marks} />)
    const mark = screen.getByRole('button', { name: 'first place: Paris' })
    expect(mark.textContent).toBe('Paris')
    fireEvent.click(mark)
    expect(onSelect).toHaveBeenCalledWith([firstKey], mark)
    rerender(<TestMarkdown {...source} marks={marks} marksShown={false} />)
    expect(screen.queryByRole('button', { name: 'first place: Paris' })).toBeNull()
    expect(screen.getByRole('button', { name: 'place: Paris' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByLabelText('Parsed Markdown').textContent).toBe(source.markdown)
  })

  it('keeps overlapping values selectable without nesting buttons or duplicating source text', () => {
    const source = fixture(), onSelect = vi.fn(), widerKey = 'phrase'
    const describe = new Map([...descriptions, [widerKey, { ...descriptions.get(valueKey)!, name: 'phrase', value: 'puis Paris' }]])
    render(<TestMarkdown {...source} marks={{ describe, selected: null, onSelect, savedLinks: [
      { key: valueKey, link: located },
      { key: widerKey, link: { ...located, location: { raw: 'puis Paris', textSpans: spans(second - 5, second + 5) } } },
    ] }} />)
    const shared = screen.getByRole('button', { name: 'place: Paris; phrase: puis Paris' })
    expect(shared.textContent).toBe('Paris')
    expect(screen.getByRole('button', { name: 'phrase: puis Paris' }).textContent).toBe('puis ')
    fireEvent.click(shared)
    expect(onSelect).toHaveBeenCalledWith([valueKey, widerKey], shared)
    expect(shared.querySelector('button')).toBeNull()
    expect(screen.getByLabelText('Parsed Markdown').textContent).toBe(source.markdown)
  })

  it('retains a fallback value alongside a precisely located value in the same passage', () => {
    const source = fixture(), onSelect = vi.fn(), fallbackKey = 'context'
    const describe = new Map([...descriptions, [fallbackKey, { ...descriptions.get(valueKey)!, name: 'context' }]])
    render(<TestMarkdown {...source} marks={{ describe, selected: null, onSelect, savedLinks: [
      { key: valueKey, link: located }, { key: fallbackKey, link: { ...located, location: undefined } },
    ] }} />)
    const shared = screen.getByRole('button', { name: 'place: Paris; context: Paris' })
    expect(shared.textContent).toBe('Paris')
    const context = screen.getAllByRole('button', { name: 'context: Paris' })[0]!
    fireEvent.click(context)
    expect(onSelect).toHaveBeenCalledWith([fallbackKey], context)
    expect(screen.getByLabelText('Parsed Markdown').textContent).toBe(source.markdown)
  })
})
