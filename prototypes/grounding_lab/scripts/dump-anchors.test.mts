import assert from 'node:assert/strict'
import test from 'node:test'
import { tableCellContexts } from './dump-anchors.mts'

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
