import { describe, expect, it } from 'vitest'
import type { ParsedDocument } from 'extraction/parsed-document'
import { evidenceQuote } from './evidenceQuote'

const document = {
  content_stream: [
    { kind: 'paragraph', block_id: 'b1', text: 'Graven var orienteret NØ-SV. Oprindelig længde kan ikke bestemmes.' },
    { kind: 'list', block_id: 'b2', items: ['Jern', 'Bronze'] },
    { kind: 'paragraph', block_id: 'b3', text: `${'a'.repeat(200)} mand ${'b'.repeat(200)}` },
  ],
  tables: [{ table_id: 't1', cells: [
    { row: 0, column: 1, text: 'Jern' }, { row: 0, column: 0, text: '8-2' }, { row: 0, column: 2, text: 'jernspænde' }, { row: 1, column: 0, text: '8-3' },
  ] }],
  evidence_index: { anchors: [
    { kind: 'text', anchor_id: 'a1', block_id: 'b1' }, { kind: 'text', anchor_id: 'a2', block_id: 'b2' },
    { kind: 'text', anchor_id: 'a3', block_id: 'b3' },
    { kind: 'table_cell', anchor_id: 'c1', logical_table_id: 't1', canonical_row: 0, canonical_column: 2 },
  ] },
} as unknown as ParsedDocument

describe('evidenceQuote (results review redesign §7.1)', () => {
  it('marks the grounding raw text case-insensitively, else the value', () => {
    expect(evidenceQuote(document, 'a1', 'nø-sv', 'x')).toEqual({ before: 'Graven var orienteret ', hit: 'NØ-SV', after: '. Oprindelig længde kan ikke bestemmes.' })
    expect(evidenceQuote(document, 'a1', null, 'Oprindelig')?.hit).toBe('Oprindelig')
  })

  it('quotes a cell with its row\'s cells joined, and a list\'s items joined', () => {
    expect(evidenceQuote(document, 'c1', null, 'jernspænde')).toEqual({ before: '8-2 · Jern · ', hit: 'jernspænde', after: '' })
    expect(evidenceQuote(document, 'a2', null, 'Bronze')).toEqual({ before: 'Jern · ', hit: 'Bronze', after: '' })
  })

  it('has no mark when the value is not in its passage, and no quote for an anchor the document lacks', () => {
    expect(evidenceQuote(document, 'a1', null, 'SØ-NV')).toEqual({ before: 'Graven var orienteret NØ-SV. Oprindelig længde kan ikke bestemmes.', hit: '', after: '' })
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
