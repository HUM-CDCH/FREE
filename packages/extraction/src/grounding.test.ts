import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import parsedDocument from '../../../prototypes/studio/src/assets/parsed_document.v2.json' with { type: 'json' }
import { groundExtraction } from './grounding.js'
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

describe('lexical containment', () => {
  it('matches bounded tokens only', () => {
    assert.equal(boundedContains('4', normalizeLexical('Grave 4, 1904')), true)
    assert.equal(boundedContains('4', normalizeLexical('1904')), false)
    assert.equal(boundedContains('4.4', normalizeLexical('4.3–4.4 m')), false)
    assert.equal(boundedContains('1.5', normalizeLexical('ca. 1,5 m')), true)
    assert.equal(boundedContains('wolfenbüttel', normalizeLexical('Kr. Wolfenbüttel.')), true)
    assert.equal(boundedContains('a', 'a'), true)
    assert.equal(boundedContains('a', 'a b'), false)
  })
})

describe('groundExtraction lexical checks', () => {
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
})
