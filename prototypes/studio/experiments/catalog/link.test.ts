import assert from 'node:assert/strict'
import { test } from 'vitest'
import { lexicalCandidates } from './link.js'

test('repeated locality in narrative does not replace its entry header', () => {
  const candidates = [{ anchorId: 'header', text: '901. Musterdorf. Fdpl. u. Mbl. 9999.' }, { anchorId: 'narrative', text: 'Museum in Musterdorf.' }]
  assert.equal(lexicalCandidates('locality', 'Musterdorf', candidates, false).length, 2)
  assert.deepEqual(lexicalCandidates('locality', 'Musterdorf', candidates, true).map(e => e.anchorId), ['header'])
})
test('parent find type is not replaced by a later sub-find code', () => {
  const candidates = [{ anchorId: 'parent', text: 'FA: EvG. Altfund.' }, { anchorId: 'subfind', text: 'FA: G. Other detail.' }]
  assert.deepEqual(lexicalCandidates('find_type', 'G', candidates, true), [])
  assert.deepEqual(lexicalCandidates('find_type', 'EvG', candidates, true).map(e => e.anchorId), ['parent'])
})
test('a matching alternative map number does not support the requested first sheet', () => {
  const candidates = [{ anchorId: 'header', text: 'Mbl. 9999 (0000) oder 9998 (0001).' }]
  assert.deepEqual(lexicalCandidates('map_sheet', 9998, candidates, true), [])
  assert.equal(lexicalCandidates('map_sheet', 9999, candidates, true).length, 1)
})
test('normalizes OCR east-west and long dashes, preserving ambiguity for abstention', () => {
  const candidates = [{ anchorId: 'grave', text: 'Kammer; 0—W.' }, { anchorId: 'other', text: 'Pflaster in O-W-Richtung.' }]
  assert.equal(lexicalCandidates('burial_axis', 'O-W', candidates.slice(0, 1), true).length, 1)
  assert.equal(lexicalCandidates('burial_axis', 'O-W', candidates, true).length, 2)
  assert.equal(lexicalCandidates('burial_axis', null, candidates, true).length, 0)
})
