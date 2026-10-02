import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contestedValues } from './contested-values.js'

const issue = (code: string, detail: unknown, record: number | null) =>
  ({ code, detail: typeof detail === 'string' ? detail : JSON.stringify(detail), record, path: null })

test('a version 1 record conflict is that record\'s contested value, with its candidates', () => {
  const diagnostics = { groundingIssues: [issue('conflicting_values', { path: ['venue', 'city'], candidates: ['Oslo', 'Bergen'] }, 1)] }
  const result = { records: [{ venue: { city: 'Rome' } }, { venue: { city: null } }] }
  assert.deepEqual(contestedValues(diagnostics, result), [{ resultPath: ['records', 1, 'venue', 'city'], candidates: ['Oslo', 'Bergen'] }])
})

test('a version 1 document conflict is contested in every record it was merged into', () => {
  const diagnostics = { groundingIssues: [issue('conflicting_document_values', { path: ['year'], candidates: [1901, 1902] }, null)] }
  assert.deepEqual(contestedValues(diagnostics, { records: [{ year: null }, { year: null }] }), [
    { resultPath: ['records', 0, 'year'], candidates: [1901, 1902] },
    { resultPath: ['records', 1, 'year'], candidates: [1901, 1902] },
  ])
})

test('a version 2 unresolved competitor is contested once, though its issue repeats it; an arbitrated one is not', () => {
  const candidate = (value: unknown) => ({ value, spans: [{ segment: 'p1_s1', start: 0, end: 3 }], window: 0 })
  const diagnostics = {
    groundingIssues: [{ code: 'competitors_unresolved', detail: '2 verified values disagree', record: 0, path: ['records', 0, 'title'] }],
    grounded: { competitors: [
      { path: ['records', 0, 'title'], candidates: [candidate('A'), candidate('B')], outcome: 'unresolved' },
      { path: ['records', 0, 'maker'], candidates: [candidate('C'), candidate('D')], outcome: 'arbitrated' },
    ] },
  }
  assert.deepEqual(contestedValues(diagnostics, { records: [{ title: null, maker: 'C' }] }),
    [{ resultPath: ['records', 0, 'title'], candidates: ['A', 'B'] }])
})

test('a malformed detail is skipped, and a value a review supplied is no longer contested', () => {
  const diagnostics = { groundingIssues: [
    issue('conflicting_values', '{not json', 0),
    issue('conflicting_values', { path: 'title', candidates: ['A'] }, 0),
    issue('conflicting_values', { path: ['title'], candidates: ['A', 'B'] }, 0),
    'not an issue',
  ] }
  assert.deepEqual(contestedValues(diagnostics, { records: [{ title: 'A (reviewed)' }] }), [])
  assert.deepEqual(contestedValues(diagnostics, { records: [{ title: '' }] }), [{ resultPath: ['records', 0, 'title'], candidates: ['A', 'B'] }])
  assert.deepEqual(contestedValues(null, { records: [] }), [])
  assert.deepEqual(contestedValues(diagnostics, null), [])
})
