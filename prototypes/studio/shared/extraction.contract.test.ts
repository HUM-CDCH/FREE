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
    values: null,
    grounding: null,
  },
  failure: null,
  resultPayload: { records: [{}] },
  evidenceLinks: [],
  reviewable: true,
  retryOfId: null,
  batchExtractionId: null,
  createdAt: '2026-08-10T00:00:00.000Z',
  reviewedAt: null,
  reviewDecisions: [],
} as const

describe('Article lifecycle contracts', () => {
  it('accepts a strict completed empty attempt and rejects contradictory terminal fields', () => {
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

  it('accepts Catalog strategy only with ordered stage and boundary diagnostics', () => {
    const diagnostics = {
      ...completed.diagnostics,
      catalog: {
        stages: [{
          stage: 'discovery',
          outcome: 'succeeded',
          finishReason: 'stop',
          calls: 1,
          inputTokens: 10,
          outputTokens: 4,
          durationMs: 1,
          failureCode: null,
        }],
        records: [{
          ordinal: 0,
          boundary: {
            startBlockId: 'heading-1',
            startContentIndex: 2,
            endContentIndex: 5,
            headingText: 'Heading',
            headingLevel: 1,
          },
          outcome: 'succeeded',
          finishReason: 'stop',
          calls: 1,
          inputTokens: 10,
          outputTokens: 4,
          durationMs: 1,
          failureCode: null,
        }],
      },
    }
    expect(extractionAttemptSchema.safeParse({
      ...completed,
      strategy: 'CATALOG',
      diagnostics,
    }).success).toBe(true)
    expect(extractionAttemptSchema.safeParse({
      ...completed,
      strategy: 'CATALOG',
    }).success).toBe(false)
  })

  it('separates fresh requests from strict targeted retry selections', () => {
    const request = extractionRequestSchema.safeParse({
      id: id('1'),
      retryOfId: id('5'),
      retryDocument: false,
      rediscover: false,
      retryRecordStartBlockIds: ['heading-1'],
    })
    expect(request.success).toBe(true)
    if (request.success) {
      expect(request.data.retryOfId).toBe(id('5'))
      expect(request.data.sourceRepresentationRevisionId).toBeUndefined()
      expect(request.data.schemaRevisionId).toBeUndefined()
      expect(request.data.strategy).toBeUndefined()
    }
    expect(
      extractionRequestSchema.safeParse({
        id: id('1'),
        sourceRepresentationRevisionId: id('3'),
        schemaRevisionId: id('4'),
        strategy: 'CATALOG',
        retryOfId: id('5'),
        retryRecordStartBlockIds: ['heading-1'],
      }).success,
    ).toBe(false)
    expect(
      extractionRequestSchema.safeParse({
        id: id('1'),
        sourceRepresentationRevisionId: id('3'),
        schemaRevisionId: id('4'),
        strategy: 'CATALOG',
        retryOfId: id('5'),
        retryRecordStartBlockIds: ['heading-1', 'heading-1'],
      }).success,
    ).toBe(false)
    expect(
      extractionRequestSchema.safeParse({
        id: id('1'),
        retryOfId: id('5'),
        retryRecordStartBlockIds: Array.from(
          { length: 101 },
          (_, index) => `heading-${index}`,
        ),
      }).success,
    ).toBe(false)

    expect(
      extractionRequestSchema.safeParse({
        id: id('1'),
        sourceRepresentationRevisionId: id('3'),
        schemaRevisionId: id('4'),
        strategy: 'ARTICLE',
        retryDocument: false,
      }).success,
    ).toBe(false)
  })
})
