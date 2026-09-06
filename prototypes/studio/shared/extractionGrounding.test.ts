import { describe, expect, it, vi } from 'vitest'
import bundled from '../src/assets/parsed_document.v2.json'
import {
  groundExtraction,
  populatedContentPaths,
  type GroundingModel,
} from 'extraction/grounding'
import { decodeParsedDocument } from 'extraction/parsed-document'

const document = decodeParsedDocument(bundled)
const firstAnchorId = document.evidence_index.anchors[0]!.anchor_id
const metadata = {
  finishReason: 'stop',
  inputTokens: 2,
  outputTokens: 1,
  durationMs: 3,
}

function model(
  ground: GroundingModel['ground'],
): GroundingModel {
  return { ground }
}

describe('canonical Extraction grounding', () => {
  it('enumerates populated scalar paths without empty values', () => {
    expect(
      populatedContentPaths({
        records: [{ title: 'Alpha', empty: '', year: 1901 }],
      }),
    ).toEqual([
      ['records', 0, 'title'],
      ['records', 0, 'year'],
    ])
  })

  it('grounds records in deterministic batches and retains diagnostics', async () => {
    const requests: Array<{ claims: readonly string[] }> = []
    const grounded = await groundExtraction(
      document,
      {
        records: [
          { title: 'Alpha', count: 2 },
          { title: 'Beta', checked: false },
        ],
      },
      model(async (request) => {
        const claimLabels = Object.keys(request.claims)
        requests.push({ claims: claimLabels })
        return {
          selections: claimLabels.map((claimLabel) => ({
            claimLabel,
            anchorLabel: claimLabel === 'C2' ? null : 'E1',
          })),
          metadata,
        }
      }),
      new AbortController().signal,
      { now: () => 10 },
    )

    expect(requests).toEqual([
      { claims: ['C1', 'C2'] },
      { claims: ['C3', 'C4'] },
    ])
    expect(grounded.evidence).toEqual([
      { resultPath: ['records', 0, 'title'], evidenceAnchorId: firstAnchorId, verbatim: false, lexicalHits: 0 },
      { resultPath: ['records', 1, 'title'], evidenceAnchorId: firstAnchorId, verbatim: false, lexicalHits: 0 },
      // Booleans are never verbatim in a source and carry no lexical check.
      { resultPath: ['records', 1, 'checked'], evidenceAnchorId: firstAnchorId },
    ])
    expect(grounded.ungroundedPaths).toEqual([['records', 0, 'count']])
    expect(grounded.batches).toEqual([
      expect.objectContaining({
        resultPath: ['records', 0],
        candidateCount: 1,
        outcome: 'succeeded',
        inputTokens: 2,
      }),
      expect.objectContaining({
        resultPath: ['records', 1],
        candidateCount: 1,
        outcome: 'succeeded',
        outputTokens: 1,
      }),
    ])
  })

  it('continues after a failed batch and records it once', async () => {
    const ground = vi
      .fn<GroundingModel['ground']>()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce({
        selections: [{ claimLabel: 'C2', anchorLabel: 'E1' }],
        metadata,
      })
    const grounded = await groundExtraction(
      document,
      { records: [{ title: 'first' }, { title: 'second' }] },
      model(ground),
      new AbortController().signal,
    )

    expect(ground).toHaveBeenCalledTimes(2)
    expect(grounded.issues).toEqual([
      { code: 'grounding_failed', resultPath: ['records', 0] },
    ])
    expect(grounded.ungroundedPaths).toEqual([['records', 0, 'title']])
    expect(grounded.batches[0]).toMatchObject({
      outcome: 'failed',
      fallback: true,
    })
  })

  it('does not dispatch another batch after cancellation', async () => {
    const controller = new AbortController()
    const ground = vi.fn<GroundingModel['ground']>(async (request) => {
      controller.abort()
      return {
        selections: Object.keys(request.claims).map((claimLabel) => ({
          claimLabel,
          anchorLabel: 'E1',
        })),
        metadata,
      }
    })

    await expect(
      groundExtraction(
        document,
        { records: [{ title: 'first' }, { title: 'second' }] },
        model(ground),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(ground).toHaveBeenCalledOnce()
  })

  it('rejects foreign anchors without retargeting Evidence', async () => {
    const grounded = await groundExtraction(
      document,
      { title: 'Alpha' },
      model(async () => ({
        selections: [{ claimLabel: 'C1', anchorLabel: 'E999' }],
        metadata,
      })),
      new AbortController().signal,
    )

    expect(grounded.evidence).toEqual([])
    expect(grounded.ungroundedPaths).toEqual([['title']])
    expect(grounded.issues).toEqual([
      {
        code: 'unknown_anchor_label',
        claimLabel: 'C1',
        anchorLabel: 'E999',
        resultPath: ['title'],
      },
    ])
  })

  it('skips the model when there are no populated claims', async () => {
    const ground = vi.fn<GroundingModel['ground']>()
    await expect(
      groundExtraction(
        document,
        { records: [], title: '' },
        model(ground),
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      evidence: [],
      ungroundedPaths: [],
      issues: [],
      metadata: [],
      batches: [],
    })
    expect(ground).not.toHaveBeenCalled()
  })
})
