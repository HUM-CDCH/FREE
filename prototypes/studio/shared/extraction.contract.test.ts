import { describe, expect, it } from 'vitest'
import {
  extractionRequestSchema,
  extractionAttemptSchema,
} from './extraction.contract.js'

const id = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`

const completed = {
  extractionId: id('1'),
  sourceDocumentId: id('2'),
  sourceRepresentationRevisionId: id('3'),
  schemaRevisionId: id('4'),
  strategy: 'ARTICLE',
  outcome: 'SUCCEEDED',
  complete: true,
  modelAttribution: { provider: 'ollama', modelId: 'fixture' },
  diagnostics: {
    phase: 'grounding',
    durationMs: 1,
    modelCalls: 0,
    finishReason: null,
    inputTokens: null,
    outputTokens: null,
    grounding: null,
    catalog: null,
  },
  failure: null,
  resultPayload: { records: [{ filename: 'source.pdf' }] },
  evidenceLinks: [],
  reviewable: true,
  retryOfId: null,
  createdAt: '2026-08-10T00:00:00.000Z',
  reviewedAt: null,
  reviewDecisions: [],
} as const

describe('Article lifecycle contracts', () => {
  it('accepts a strict completed package-only attempt and rejects contradictory terminal fields', () => {
    expect(extractionAttemptSchema.safeParse(completed).success).toBe(true)
    expect(
      extractionAttemptSchema.safeParse({
        ...completed,
        outcome: 'FAILED',
        failure: { code: 'failed', message: 'Failed.' },
      }).success,
    ).toBe(false)
    expect(
      extractionRequestSchema.safeParse({
        id: id('1'),
        sourceRepresentationRevisionId: id('3'),
        schemaRevisionId: id('4'),
        strategy: 'ARTICLE',
        result: {},
      }).success,
    ).toBe(false)
  })

  it('requires exact reviewed-anchor coverage', () => {
    expect(
      extractionAttemptSchema.safeParse({
        ...completed,
        evidenceLinks: [
          { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' },
        ],
        reviewedAt: '2026-08-10T00:01:00.000Z',
      }).success,
    ).toBe(false)
  })
})
