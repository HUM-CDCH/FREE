import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  evidenceAnchorIdOf, evidenceSchema, groundedEvidenceLink, groundedEvidenceSchema, plainEvidenceLink, unifiedEvidenceLink, unifiedEvidenceSchema,
} from './kei-evidence.js'

const plain = { path: ['records', 0, 'title'], segment: 'p1_s0', page: 1, bbox_pt: null, verbatim: true, linked_by: 'lexical' as const }
const span = { segment: 'p1_s0', start: 4, end: 8 }

test('record attribution context survives producer decoding and projection separately from value spans', () => {
  const context = [{ segment: 'p2_s0', start: 0, end: 24 }]
  const decoded = evidenceSchema.parse({ ...plain, context })
  assert.deepEqual(plainEvidenceLink(decoded, 'a_p1_s0').contextSpans, context)
  const unified = unifiedEvidenceSchema.parse({ ...plain, context, support: 'literal', spans: [span],
    alternatives: [], precision: 'segment', raw: 'Book', item: null })
  const link = unifiedEvidenceLink(unified, 'a_p1_s0')
  assert.deepEqual(link.contextSpans, context)
  assert.deepEqual(link.grounding.textSpans, [span])
  assert.equal(evidenceSchema.safeParse({ ...plain, context: [{ ...span, start: 8 }] }).success, false)
  assert.equal(evidenceSchema.safeParse({ ...plain, context: [{ ...span, segment: 'invented' }] }).success, false)
})

test('a producer link names its segment anchor, or its cell anchor inside a table', () => {
  assert.equal(evidenceAnchorIdOf(plain), 'a_p1_s0')
  assert.equal(evidenceAnchorIdOf({ ...plain, cell: 'r1_c2' }), 'a_p1_s0_r1_c2')
})

test('each producer version projects onto the rail link without inventing precision or grounding', () => {
  assert.deepEqual(plainEvidenceLink(plain, 'a_p1_s0'),
    { resultPath: plain.path, evidenceAnchorId: 'a_p1_s0', verbatim: true, linkedBy: 'lexical' })
  assert.equal('precision' in plainEvidenceLink({ ...plain, linked_by: 'model' }, 'a_p1_s0'), false)
  const grounded = groundedEvidenceSchema.parse({ ...plain, linked_by: 'key', spans: [span], alternatives: [], provenance: 'token',
    key_spans: [span], heading: null, precision: 'segment', raw: 'Book', normalized: null })
  assert.deepEqual(groundedEvidenceLink(grounded, 'a_p1_s0').grounding,
    { linkedBy: 'key', provenance: 'token', textSpans: [span], keySpans: [span], alternatives: [], heading: null,
      precision: 'segment', raw: 'Book', normalized: null })
  const unified = unifiedEvidenceSchema.parse({ ...plain, linked_by: 'verification', support: 'supporting', spans: [span],
    alternatives: [], precision: 'input', raw: 'yes', item: null })
  assert.deepEqual(unifiedEvidenceLink(unified, 'a_p1_s0').grounding,
    { linkedBy: 'verification', support: 'supporting', textSpans: [span], alternatives: [], precision: 'input', raw: 'yes', itemSpans: null })
  // A single-pass unified link: only code located it, and it keeps its spans rather than reading as a plain link.
  const located = unifiedEvidenceSchema.parse({ ...plain, support: 'literal', spans: [span], alternatives: [],
    precision: 'segment', raw: 'Book', item: [span] })
  assert.deepEqual(unifiedEvidenceLink(located, 'a_p1_s0').grounding,
    { linkedBy: 'lexical', support: 'literal', textSpans: [span], alternatives: [], precision: 'segment', raw: 'Book', itemSpans: [span] })
})

test('producer decoders retain only their declared fields', () => {
  const grounded = { ...plain, linked_by: 'key', spans: [span], alternatives: [[span]], provenance: 'token',
    key_spans: [span], heading: null, precision: 'segment', raw: 'Book', normalized: null }
  const unified = { ...plain, support: 'literal', spans: [span], alternatives: [[span]],
    precision: 'segment', raw: 'Book', item: null }
  for (const [schema, link, project] of [
    [evidenceSchema, plain, plainEvidenceLink], [groundedEvidenceSchema, grounded, groundedEvidenceLink],
    [unifiedEvidenceSchema, unified, unifiedEvidenceLink]] as const) {
    const current = schema.parse(link) as never
    const decoded = schema.parse({ ...link, obsoleteDiagnostic: 'ignored' }) as never
    assert.deepEqual(decoded, current)
    assert.deepEqual(project(decoded, 'a_p1_s0'), project(current, 'a_p1_s0'))
  }
})

test('value boxes project on every producer version as valueBoxes, and no key when absent', () => {
  const box = [118.2, 103, 168.4, 114.2], projected = [{ x0: 118.2, y0: 103, x1: 168.4, y1: 114.2 }]
  const grounded = { ...plain, linked_by: 'key', spans: [span], alternatives: [], provenance: 'token', key_spans: [span], heading: null,
    precision: 'segment', raw: 'Book', normalized: null }
  const unified = { ...plain, support: 'literal', spans: [span], alternatives: [], precision: 'segment', raw: 'Book', item: null }
  const bad = [[], [[1, 1, 1, 5]], [[1, 5, 4, 5]], [[1, 1, 2]], [[1, 1, 2, Infinity]], [[1, 1, 2, NaN]], Array(65).fill(box)]
  const without = <T extends object>(link: T) => ({ ...link, value_boxes_pt: undefined })
  for (const [schema, link, project] of [
    [evidenceSchema, plain, plainEvidenceLink], [groundedEvidenceSchema, grounded, groundedEvidenceLink],
    [unifiedEvidenceSchema, unified, unifiedEvidenceLink]] as const) {
    const parse = (value: unknown) => schema.parse(value) as never
    assert.deepEqual((project(parse({ ...link, value_boxes_pt: [box] }), 'a_p1_s0') as { valueBoxes?: unknown }).valueBoxes, projected)
    assert.equal('valueBoxes' in project(parse(without(link)), 'a_p1_s0'), false)
    for (const value_boxes_pt of bad) assert.equal(schema.safeParse({ ...link, value_boxes_pt }).success, false, JSON.stringify(value_boxes_pt))
  }
})
