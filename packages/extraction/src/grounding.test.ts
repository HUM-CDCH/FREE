import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import parsedDocument from '../../../prototypes/studio/src/assets/parsed_document.v2.json' with { type: 'json' }
import { groundExtraction, resultPathKey } from './grounding.js'
import { PER_RECORD_CATALOG_POLICY } from './catalog.js'
import type { GroundingModelRequest } from './dependencies.js'
import { resolveCatalogBoundaries } from './catalog-boundaries.js'
import { boundedContains, normalizeLexical } from './lexical.js'
import type { ParsedDocument } from './parsed-document.js'

/** One page of paragraphs; anchor `a-b<i>` carries `texts[i]`. */
function documentWith(texts: readonly string[]): ParsedDocument {
  const blocks = texts.map((text, index) => ({ kind: 'paragraph', block_id: `b${index}`, page_number: 1, text }))
  return {
    ...parsedDocument,
    pages: [{ ...parsedDocument.pages[0], page_number: 1, ordered_content: blocks.map((block) => block.block_id), unplaced_content: [] }],
    content_stream: blocks,
    tables: [],
    evidence_index: { anchors: blocks.map((block) => ({ kind: 'text', anchor_id: `a-${block.block_id}`, block_id: block.block_id })) },
  } as unknown as ParsedDocument
}

// Replays prototypes/grounding_lab/tests/test_pipeline.py; keep both in step.
describe('normalizeLexical', () => {
  it('folds numbers, dates, spacing and markers like the lab', () => {
    const same = (left: string, right: string) => assert.equal(normalizeLexical(left), normalizeLexical(right))
    assert.equal(normalizeLexical('1.234,56'), '1234.56')
    same('1.234,56', '1,234.56')
    assert.equal(normalizeLexical('17.06.1790'), '1790-06-17')
    assert.equal(normalizeLexical('17/6/1790'), '1790-06-17')
    assert.equal(normalizeLexical('1790-06-17'), '1790-06-17')
    assert.equal(normalizeLexical('35.06.1790'), '35.06.1790')
    assert.equal(normalizeLexical('3.13.1790'), '3.13.1790')
    assert.equal(normalizeLexical('Ærø, Danmark!'), 'ærø danmark')
    assert.equal(normalizeLexical('13. august 2004'), '2004-08-13')
    assert.equal(normalizeLexical('August 13, 2004'), '2004-08-13')
    assert.equal(normalizeLexical('17 juin 1790'), '1790-06-17')
    assert.equal(normalizeLexical('den 13. august 2004.'), 'den 2004-08-13.')
    assert.equal(normalizeLexical('40 august 2004'), '40 august 2004')
    assert.equal(normalizeLexical('645 000'), '645000')
    assert.equal(normalizeLexical('1 234 567,89'), '1234567.89')
    assert.equal(normalizeLexical('page 5 200'), 'page 5 200')
    assert.equal(normalizeLexical('in 2024 100 cases'), 'in 2024 100 cases')
    same('1300m2', '1300 m2')
    same('1,300m2', '1,300 m2')
    same('50 %', '50%')
    same('$ 50', '$50')
    same('50 €', '50€')
  })
})

describe('boundedContains', () => {
  it('matches the lab cases', () => {
    const cases: [string | number | boolean, string, boolean][] = [
      ['1.234,56', 'Total 1,234.56 kg', true],
      ['18', 'dated 1834', false],
      ['8-1', 'find 8-1', true],
      ['1', 'find 8-1', false],
      ['4.4', '4.3-4.4', false],
      ['4.4', '4.3–4.4', false],
      ['4.4', '4.4 | 4.2', true],
      ['x', 'x', true],
      ['x', 'grade x', false],
      [5, 'there were 5 cases', true],
      [12, '12.5', false],
      [5, '0.5', false],
      [5, '.5', false],
      [50, '-50', false],
      [50, '−50', false],
      [-50, '-50', true],
      [12.5, '12.5', true],
      [12, 'There were 12.', true],
      ['weight 12', 'weight 12.5', false],
      [true, 'true', true],
      ['5200', 'page 5 200', false],
      ['1234', '1 234', true],
      ['645000', '645 000 bebes', true],
      ['645 000', '645000 bebes', true],
      ['645 000', '645 000 bebes', true],
      ['−6 000', '-6000', true],
      ['1300 m2', 'udgrave 1300m2 i 100m zonen', true],
      ['1,300 m2', 'area 1,300m2', true],
      ['2', '1300m2', false],
      ['50%', 'rate: 50 %', true],
      ['$50', 'budget: $ 50', true],
      ['50%', 'budget: $50', false],
      ['$50', 'rate: 50%', false],
      ['$50', 'budget: €50', false],
      ['$116,800', 'income in 2024 ($116,800), followed by', true],
      ['wolfenbüttel', 'Kr. Wolfenbüttel.', true],
    ]
    for (const [value, text, expected] of cases) assert.equal(boundedContains(value, text), expected, `${String(value)} in ${text}`)
  })
})

describe('groundExtraction lexical checks', () => {
  it('limits catalogue evidence to its record and rejects a neighbouring record anchor', async () => {
    const document = documentWith(['1. First place', 'Iron', '2. Second place', 'Bronze'])
    const shown: string[][] = []
    const outcome = await groundExtraction(document, { records: [{ find: 'Iron' }, { find: 'Bronze' }] }, {
      async ground(request) {
        shown.push(Object.values(request.anchors))
        return {
          selections: [{ claimLabel: Object.keys(request.claims)[0], anchorLabel: 'E4' }],
          metadata: { finishReason: 'stop', inputTokens: 1, outputTokens: 1, durationMs: 1 },
        }
      },
    }, new AbortController().signal, { recordBoundaries: resolveCatalogBoundaries(document, ['b0', 'b2']) })
    assert.deepEqual(shown, [['1. First place', 'Iron'], ['2. Second place', 'Bronze']])
    assert.deepEqual(outcome.batches.map(batch => batch.candidateCount), [2, 2])
    assert.deepEqual(outcome.evidence.map(link => link.resultPath), [['records', 1, 'find']])
    assert.equal(outcome.issues[0].code, 'unknown_anchor_label')
  })

  it('counts lexical hits only among the record slice the grounder was shown', async () => {
    const document = documentWith(['1. First place', 'Iron', '2. Second place', 'Iron'])
    const outcome = await groundExtraction(document, { records: [{ find: 'Iron' }, { find: 'Iron' }] }, {
      async ground(request) {
        return {
          selections: [{ claimLabel: Object.keys(request.claims)[0], anchorLabel: Object.keys(request.anchors)[1] }],
          metadata: { finishReason: 'stop', inputTokens: 1, outputTokens: 1, durationMs: 1 },
        }
      },
    }, new AbortController().signal, { recordBoundaries: resolveCatalogBoundaries(document, ['b0', 'b2']) })
    assert.deepEqual(outcome.evidence, [
      { resultPath: ['records', 0, 'find'], evidenceAnchorId: 'a-b1', verbatim: true, lexicalHits: 1 },
      { resultPath: ['records', 1, 'find'], evidenceAnchorId: 'a-b3', verbatim: true, lexicalHits: 1 },
    ])
  })

  it('flags partial decimal and sign matches as absent from the evidence', async () => {
    const outcome = await groundExtraction(
      documentWith(['12.5', '-50', '0.5']),
      { measurement: 12, balance: 50, fraction: 5 },
      {
        async ground() {
          return {
            selections: [1, 2, 3].map((index) => ({ claimLabel: `C${index}`, anchorLabel: `E${index}` })),
            metadata: { finishReason: 'stop', inputTokens: 1, outputTokens: 1, durationMs: 1 },
          }
        },
      },
      new AbortController().signal,
    )
    assert.equal(outcome.evidence.length, 3)
    for (const link of outcome.evidence) {
      assert.equal(link.verbatim, false)
      assert.equal(link.lexicalHits, 0)
    }
  })

  it('flags each link with verbatim and lexicalHits', async () => {
    const document = documentWith([
      'Grave 12 held a bronze pin.',
      'Grave 12 lay beside grave 7.',
      'The site is Wolfenbüttel.',
    ])
    const result = { grave: 12, place: 'Wolfenbüttel', material: 'iron', adult: true }
    const anchorLabels: string[] = []
    const outcome = await groundExtraction(
      document,
      result,
      {
        async ground(request) {
          anchorLabels.push(...Object.keys(request.anchors))
          const [first, , third] = Object.keys(request.anchors)
          return {
            selections: [
              { claimLabel: 'C1', anchorLabel: first! },
              { claimLabel: 'C2', anchorLabel: third! },
              { claimLabel: 'C3', anchorLabel: first! },
              { claimLabel: 'C4', anchorLabel: first! },
            ],
            metadata: { finishReason: 'stop', inputTokens: 1, outputTokens: 1, durationMs: 1 },
          }
        },
      },
      new AbortController().signal,
    )
    assert.equal(anchorLabels.length, 3)
    const byPath = new Map(outcome.evidence.map((link) => [String(link.resultPath[0]), link]))
    assert.deepEqual(byPath.get('grave'), { resultPath: ['grave'], evidenceAnchorId: 'a-b0', verbatim: true, lexicalHits: 2 })
    assert.deepEqual(byPath.get('place'), { resultPath: ['place'], evidenceAnchorId: 'a-b2', verbatim: true, lexicalHits: 1 })
    assert.deepEqual(byPath.get('material'), { resultPath: ['material'], evidenceAnchorId: 'a-b0', verbatim: false, lexicalHits: 0 })
    assert.deepEqual(byPath.get('adult'), { resultPath: ['adult'], evidenceAnchorId: 'a-b0' })
    assert.deepEqual(outcome.ungroundedPaths, [])
  })

  it('shows the grounder each anchor whole, including pipes and newlines', async () => {
    const pinched = 'Table 3 | Grain prices, 1750\nSecond line.'
    const document = documentWith([pinched])
    let shown: Record<string, string> = {}
    await groundExtraction(
      document,
      { caption: 'Grain prices, 1750' },
      {
        async ground(request) {
          shown = request.anchors
          return {
            selections: [{ claimLabel: 'C1', anchorLabel: Object.keys(request.anchors)[0]! }],
            metadata: { finishReason: 'stop', inputTokens: 1, outputTokens: 1, durationMs: 1 },
          }
        },
      },
      new AbortController().signal,
    )
    assert.deepEqual(Object.values(shown), [pinched])
  })

  describe('Catalog policy', () => {
    const metadata = { finishReason: 'stop', inputTokens: 1, outputTokens: 1, durationMs: 1 } as const

    it('links a unique lexical hit without the model and sends the rest', async () => {
      const document = documentWith(['1. First place, iron age', 'Iron', '2. Second place', 'Bronze'])
      const requests: GroundingModelRequest[] = []
      const outcome = await groundExtraction(document, { records: [{ find: 'Iron', place: 'First place' }, { find: 'Bronze' }] }, {
        async ground(request) {
          requests.push(request)
          return { selections: [{ claimLabel: Object.keys(request.claims)[0]!, anchorLabel: Object.keys(request.anchors)[1]! }], metadata }
        },
      }, new AbortController().signal, {
        recordBoundaries: resolveCatalogBoundaries(document, ['b0', 'b2']),
        policy: { ...PER_RECORD_CATALOG_POLICY, lexicalLinks: true },
      })
      // "Iron" is in two candidates of record 0: the model decides. "First place"
      // and "Bronze" are bounded tokens of exactly one candidate: linked in code.
      assert.deepEqual(requests.map((request) => Object.values(request.claims)), [['Iron']])
      assert.deepEqual(outcome.evidence, [
        { resultPath: ['records', 0, 'place'], evidenceAnchorId: 'a-b0', verbatim: true, lexicalHits: 1, linkedBy: 'lexical' },
        { resultPath: ['records', 0, 'find'], evidenceAnchorId: 'a-b1', verbatim: true, lexicalHits: 2 },
        { resultPath: ['records', 1, 'find'], evidenceAnchorId: 'a-b3', verbatim: true, lexicalHits: 1, linkedBy: 'lexical' },
      ])
      assert.equal(outcome.batches.length, 1)
      assert.deepEqual(outcome.issues, [])
    })

    it('links a verified citation without the model and grounds every other claim', async () => {
      const document = documentWith(['1. First place', 'Iron', '2. Second place', 'Bronze'])
      const requests: GroundingModelRequest[] = []
      const outcome = await groundExtraction(document, { records: [{ find: 'Iron', place: 'Elsewhere' }, { find: 'Bronze' }] }, {
        async ground(request) {
          requests.push(request)
          return { selections: Object.keys(request.claims).map((claimLabel) => ({ claimLabel, anchorLabel: null })), metadata }
        },
      }, new AbortController().signal, {
        recordBoundaries: resolveCatalogBoundaries(document, ['b0', 'b2']),
        policy: { ...PER_RECORD_CATALOG_POLICY, citationLinks: true },
        citations: new Map([
          [resultPathKey(['records', 0, 'find']), 'a-b1'], // the value is in the cited block of its own record: linked in code
          [resultPathKey(['records', 0, 'place']), 'a-b0'], // the value is not in the cited block: grounder
          [resultPathKey(['records', 1, 'find']), 'a-b1'], // the cited block belongs to another record: grounder
        ]),
      })
      assert.deepEqual(outcome.evidence, [{ resultPath: ['records', 0, 'find'], evidenceAnchorId: 'a-b1', verbatim: true, lexicalHits: 1, linkedBy: 'citation_lexical' }])
      assert.deepEqual(requests.map((request) => Object.values(request.claims)), [['Elsewhere'], ['Bronze']])
      assert.deepEqual(outcome.ungroundedPaths, [['records', 0, 'place'], ['records', 1, 'find']])
    })

    it('sends cited claims of routed fields and repeated values to the model', async () => {
      const document = documentWith(['1. Iron place, axis N', 'Iron', '2. Second place', 'Bronze'])
      const requests: GroundingModelRequest[] = []
      const outcome = await groundExtraction(document, { records: [{ find: 'Iron', axis: 'N' }, { find: 'Bronze' }] }, {
        async ground(request) {
          requests.push(request)
          return { selections: Object.keys(request.claims).map((claimLabel) => ({ claimLabel, anchorLabel: null })), metadata }
        },
      }, new AbortController().signal, {
        recordBoundaries: resolveCatalogBoundaries(document, ['b0', 'b2']),
        policy: { ...PER_RECORD_CATALOG_POLICY, citationLinks: true, groundAlways: ['axis'], groundMultiHit: true },
        schemaNodes: [{ id: 'find', name: 'find', type: 'string' }, { id: 'axis', name: 'axis', type: 'string' }],
        citations: new Map([
          [resultPathKey(['records', 0, 'find']), 'a-b1'], // verbatim, but in two blocks of the record: grounder
          [resultPathKey(['records', 0, 'axis']), 'a-b0'], // verbatim, but the field is always grounded
          [resultPathKey(['records', 1, 'find']), 'a-b3'], // linked in code
        ]),
      })
      assert.deepEqual(requests.map((request) => Object.values(request.claims)), [['Iron', 'N'], []].filter((claims) => claims.length))
      assert.deepEqual(outcome.evidence, [{ resultPath: ['records', 1, 'find'], evidenceAnchorId: 'a-b3', verbatim: true, lexicalHits: 1, linkedBy: 'citation_lexical' }])
    })

    it('never links a value in code when two candidates contain it', async () => {
      const document = documentWith(['1. Iron place', 'Iron'])
      const shown: string[] = []
      await groundExtraction(document, { records: [{ find: 'Iron' }] }, {
        async ground(request) {
          shown.push(...Object.values(request.claims).map(String))
          return { selections: [{ claimLabel: 'C1', anchorLabel: null }], metadata }
        },
      }, new AbortController().signal, { recordBoundaries: resolveCatalogBoundaries(document, ['b0']), policy: { ...PER_RECORD_CATALOG_POLICY, lexicalLinks: true } })
      assert.deepEqual(shown, ['Iron'])
    })

    it('groups records into one call and keeps each link inside its own record', async () => {
      const document = documentWith(['1. First place', 'Iron', '2. Second place', 'Bronze', '3. Third place', 'Gold'])
      const requests: GroundingModelRequest[] = []
      const outcome = await groundExtraction(document, { records: [{ find: 'Iron' }, { find: 'Bronze' }, { find: 'Gold' }] }, {
        async ground(request) {
          requests.push(request)
          const labels = Object.keys(request.anchors)
          // Second claim points at the first record's anchor: cross-record, rejected.
          return {
            selections: Object.keys(request.claims).map((claimLabel, index) => ({ claimLabel, anchorLabel: index === 1 ? labels[1]! : labels[index * 2 + 1]! })),
            metadata,
          }
        },
      }, new AbortController().signal, {
        recordBoundaries: resolveCatalogBoundaries(document, ['b0', 'b2', 'b4']),
        policy: { ...PER_RECORD_CATALOG_POLICY, groundingGroupSize: 2 },
      })
      assert.deepEqual(requests.map((request) => Object.keys(request.anchors).length), [4, 2])
      assert.deepEqual(outcome.batches.map((batch) => [batch.resultPath, batch.candidateCount]), [[['records', 0], 4], [['records', 2], 2]])
      assert.deepEqual(outcome.evidence.map((link) => [link.resultPath, link.evidenceAnchorId]), [[['records', 0, 'find'], 'a-b1'], [['records', 2, 'find'], 'a-b5']])
      assert.deepEqual(outcome.issues.map((issue) => [issue.code, issue.resultPath]), [['unknown_anchor_label', ['records', 1, 'find']]])
      assert.deepEqual(outcome.ungroundedPaths, [['records', 1, 'find']])
    })

    it('describes each claim to the grounder when the policy is field-aware', async () => {
      const document = documentWith(['1. First place', 'Iron'])
      const fields: Record<string, unknown> = {}
      await groundExtraction(document, { records: [{ find: 'Iron', tags: ['a'] }], site: 'First' }, {
        async ground(request) {
          Object.assign(fields, request.claimFields)
          return { selections: [], metadata }
        },
      }, new AbortController().signal, {
        recordBoundaries: resolveCatalogBoundaries(document, ['b0']),
        policy: { ...PER_RECORD_CATALOG_POLICY, fieldAwareGrounding: true, groundingGroupSize: 5 },
        schemaNodes: [
          { id: 'find', name: 'find', type: 'string', description: 'The main find material.' },
          { id: 'tags', name: 'tags', type: 'array', itemType: 'string' },
          { id: 'site', name: 'site', type: 'string', valueSource: 'document' },
        ],
      })
      assert.deepEqual(fields, {
        C1: { record: 'records[0]', field: 'find', description: 'The main find material.' },
        C2: { record: 'records[0]', field: 'tags', description: null },
        C3: { record: null, field: 'site', description: null },
      })
    })
  })
})
