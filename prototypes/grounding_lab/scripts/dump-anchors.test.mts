import assert from 'node:assert/strict'
import test from 'node:test'
import { anchorEntries, tableCellContexts } from './dump-anchors.mts'
import { readFileSync } from 'node:fs'
import { decodeParsedDocument } from 'extraction/parsed-document'
import { canonicalAnchorInventory } from 'extraction/source-context'

const cell = (evidence_anchor_id: string, row: number, text: string, role: string | null) => ({
  evidence_anchor_id, row, column: 0, text, role, colspan: 1,
})

test('column headers stay within their repeated header group', () => {
  const contexts = tableCellContexts([
    cell('header-a', 0, 'Section A', 'column_header'),
    cell('value-a', 1, '10', null),
    cell('header-b', 2, 'Section B', 'column_header'),
    cell('value-b', 3, '20', null),
  ])

  assert.equal(contexts.get('value-a'), 'Section A | 10 — 10')
  assert.equal(contexts.get('value-b'), 'Section B | 20 — 20')
})

test('header cells are not given the row values as context', () => {
  const contexts = tableCellContexts([
    cell('label', 0, 'Número de nacimientos', 'row_header'),
    { ...cell('value', 0, '320.656', null), column: 1 },
    { ...cell('delta', 0, '-2,6', null), column: 2 },
  ])

  assert.equal(contexts.get('label'), 'Número de nacimientos — Número de nacimientos')
  assert.equal(
    contexts.get('value'),
    'Número de nacimientos | 320.656 | -2,6 — 320.656',
  )
})

test('structural dump preserves canonical inventory and exports table coordinates and roles', () => {
  const document = decodeParsedDocument(JSON.parse(readFileSync(new URL('../final_dataset_3/shbat-2009-skeletal-health-en/parsed_document.json', import.meta.url), 'utf8')))
  const entries = anchorEntries(document)
  assert.deepEqual(entries.map(({ anchorId, text, page }) => ({ anchorId, text, page })),
    canonicalAnchorInventory(document).map(({ anchorId, text, page }) => ({ anchorId, text, page })))
  const cells = new Map(document.tables.flatMap((table) => table.cells.map((cell) => [cell.evidence_anchor_id, cell] as const)))
  assert.ok(entries.some((entry) => entry.kind === 'table_cell'))
  for (const entry of entries.filter((entry) => entry.kind === 'table_cell')) {
    const source = cells.get(entry.anchorId)!
    assert.equal(entry.row, source.row)
    assert.equal(entry.column, source.column)
    assert.equal(entry.role, source.role)
    assert.ok(entry.logicalTableId)
  }
})
