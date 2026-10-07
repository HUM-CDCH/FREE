import { describe, expect, it } from 'vitest'
import type { ParsedDocument } from 'extraction/parsed-document'
import { evidenceQuote } from './evidenceQuote'

const document = {
  content_stream: [
    { kind: 'paragraph', block_id: 'b1', text: 'The café wall ran NE–SW. Its full length was not recorded.' },
    { kind: 'list', block_id: 'b2', items: ['Iron', 'Bronze'] },
    { kind: 'paragraph', block_id: 'b3', text: `${'a'.repeat(200)} mand ${'b'.repeat(200)}` },
  ],
  tables: [{ table_id: 't1', cells: [
    { row: 0, column: 1, text: 'Iron' }, { row: 0, column: 0, text: '7-2' }, { row: 0, column: 2, text: 'iron buckle' }, { row: 1, column: 0, text: '7-3' },
  ] }],
  evidence_index: { anchors: [
    { kind: 'text', anchor_id: 'a1', block_id: 'b1' }, { kind: 'text', anchor_id: 'a2', block_id: 'b2' },
    { kind: 'text', anchor_id: 'a3', block_id: 'b3' },
    { kind: 'table_cell', anchor_id: 'c1', logical_table_id: 't1', canonical_row: 0, canonical_column: 2 },
  ] },
} as unknown as ParsedDocument

describe('evidenceQuote (results review redesign §7.1)', () => {
  it('marks the grounding raw text case-insensitively, else the value', () => {
    expect(evidenceQuote(document, 'a1', 'CAFÉ WALL', 'x')).toEqual({ before: 'The ', hit: 'café wall', after: ' ran NE–SW. Its full length was not recorded.' })
    expect(evidenceQuote(document, 'a1', null, 'full length')?.hit).toBe('full length')
  })

  it('quotes a cell with its row\'s cells joined, and a list\'s items joined', () => {
    expect(evidenceQuote(document, 'c1', null, 'iron buckle')).toEqual({ before: '7-2 · Iron · ', hit: 'iron buckle', after: '' })
    expect(evidenceQuote(document, 'a2', null, 'Bronze')).toEqual({ before: 'Iron · ', hit: 'Bronze', after: '' })
  })

  it('has no mark when the value is not in its passage, and no quote for an anchor the document lacks', () => {
    expect(evidenceQuote(document, 'a1', null, 'SE–NW')).toEqual({ before: 'The café wall ran NE–SW. Its full length was not recorded.', hit: '', after: '' })
    expect(evidenceQuote(document, 'missing', null, 'x')).toBeNull()
  })

  it('clips a long quote around the mark', () => {
    const quote = evidenceQuote(document, 'a3', null, 'mand')!
    expect(quote.hit).toBe('mand')
    expect(quote.before.startsWith('…')).toBe(true)
    expect(quote.after.endsWith('…')).toBe(true)
    expect(quote.before.length + quote.after.length).toBeLessThan(200)
  })
})
