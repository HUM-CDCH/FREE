import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  evidenceAnchorIdOf, groundedEvidenceLink, groundedEvidenceSchema, plainEvidenceLink, unifiedEvidenceLink, unifiedEvidenceSchema,
} from './kei-evidence.js'

const plain = { path: ['records', 0, 'title'], segment: 'p1_s0', page: 1, bbox_pt: null, verbatim: true, hits: 2, linked_by: 'lexical' as const }
const span = { segment: 'p1_s0', start: 4, end: 8 }

test('a producer link names its segment anchor, or its cell anchor inside a table', () => {
  assert.equal(evidenceAnchorIdOf(plain), 'a_p1_s0')
  assert.equal(evidenceAnchorIdOf({ ...plain, cell: 'r1_c2' }), 'a_p1_s0_r1_c2')
})

test('each producer version projects onto the rail link without inventing precision or grounding', () => {
  assert.deepEqual(plainEvidenceLink(plain, 'a_p1_s0'),
    { resultPath: plain.path, evidenceAnchorId: 'a_p1_s0', verbatim: true, lexicalHits: 2, linkedBy: 'lexical' })
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
})
