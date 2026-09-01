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
  executionStatus: 'COMPLETED',
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
    retry: null,
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
  it('accepts queued and checkpointed running jobs but rejects partial checkpoints', () => {
    const queued = {
      ...completed,
      executionStatus: 'QUEUED',
      outcome: null,
      complete: null,
      modelAttribution: null,
      diagnostics: null,
      resultPayload: null,
      evidenceLinks: null,
      reviewable: false,
    }
    expect(extractionAttemptSchema.safeParse(queued).success).toBe(true)
    expect(extractionAttemptSchema.safeParse({
      ...queued,
      executionStatus: 'RUNNING',
      complete: true,
      modelAttribution: completed.modelAttribution,
      diagnostics: completed.diagnostics,
      resultPayload: completed.resultPayload,
    }).success).toBe(true)
    expect(extractionAttemptSchema.safeParse({
      ...queued,
      executionStatus: 'RUNNING',
      resultPayload: completed.resultPayload,
    }).success).toBe(false)
  })

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

  it('keys Review Decisions by result path when values share one Evidence anchor', () => {
    const evidenceLinks = [
      { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' },
      { resultPath: ['records', 0, 'note'], evidenceAnchorId: 'anchor-1' },
    ]
    const reviewDecisions = evidenceLinks.map((link) => ({
      ...link,
      reviewedOccurrenceIds: ['occurrence-1'],
      action: 'APPROVED',
      reviewedValue: null,
      createdAt: '2026-08-10T00:01:00.000Z',
    }))
    expect(extractionAttemptSchema.safeParse({
      ...completed,
      resultPayload: { records: [{ title: 'Title', note: 'Note' }] },
      evidenceLinks,
      reviewedAt: '2026-08-10T00:01:00.000Z',
      reviewDecisions,
    }).success).toBe(true)
    expect(extractionAttemptSchema.safeParse({
      ...completed,
      resultPayload: { records: [{ title: 'Title', note: 'Note' }] },
      evidenceLinks,
      reviewedAt: '2026-08-10T00:01:00.000Z',
      reviewDecisions: reviewDecisions.map((decision) => ({
        ...decision,
        resultPath: ['records', 0, 'title'],
      })),
    }).success).toBe(false)
  })

  it('accepts Catalog strategy only with ordered stage and boundary diagnostics', () => {
    expect(
      extractionRequestSchema.safeParse({
        id: id('1'),
        sourceRepresentationRevisionId: id('3'),
        schemaRevisionId: id('4'),
        strategy: 'CATALOG',
      }).success,
    ).toBe(true)

    // Strategy and catalog diagnostics must agree in both directions.
    expect(
      extractionAttemptSchema.safeParse({
        ...completed,
        strategy: 'CATALOG',
      }).success,
    ).toBe(false)
    const stage = {
      provenance: 'executed',
      outcome: 'succeeded',
      finishReason: 'stop',
      calls: 1,
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      failureCode: null,
    } as const
    const catalog = {
      stages: (['document-values', 'discovery', 'record-values', 'grounding'] as const)
        .map((name) => ({ ...stage, stage: name })),
      records: [{
        ...stage,
        ordinal: 0,
        boundary: {
          startBlockId: 'block-1',
          startContentIndex: 0,
          endContentIndex: 2,
          headingText: 'First',
          headingLevel: 1,
        },
      }],
    }
    expect(
      extractionAttemptSchema.safeParse({
        ...completed,
        strategy: 'CATALOG',
        diagnostics: { ...completed.diagnostics, catalog },
      }).success,
    ).toBe(true)
    expect(
      extractionAttemptSchema.safeParse({
        ...completed,
        diagnostics: { ...completed.diagnostics, catalog },
      }).success,
    ).toBe(false)
  })

  it('separates fresh requests from strict targeted retry selections', () => {
    const normalized = extractionRequestSchema.parse({
      id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      sourceRepresentationRevisionId: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
      schemaRevisionId: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
      strategy: 'ARTICLE',
    })
    expect(normalized.id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(normalized.sourceRepresentationRevisionId)
      .toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')

    expect(
      extractionRequestSchema.safeParse({
        id: id('1'),
        sourceRepresentationRevisionId: id('3'),
        schemaRevisionId: id('4'),
        strategy: 'ARTICLE',
        retryOfId: id('5'),
      }).success,
    ).toBe(false)

    const retry = extractionRequestSchema.safeParse({
      id: id('1'),
      retryOfId: id('5'),
      retryRecordStartBlockIds: ['block-1'],
    })
    expect(retry.success).toBe(true)
    expect(retry.success && retry.data).toMatchObject({
      retryOfId: id('5'),
      retryDocument: false,
      rediscover: false,
      retryRecordStartBlockIds: ['block-1'],
    })

    // A retry never carries caller pins, and record identities must be unique.
    expect(
      extractionRequestSchema.safeParse({
        id: id('1'),
        retryOfId: id('5'),
        schemaRevisionId: id('4'),
      }).success,
    ).toBe(false)
    expect(
      extractionRequestSchema.safeParse({
        id: id('1'),
        retryOfId: id('5'),
        retryRecordStartBlockIds: ['block-1', 'block-1'],
      }).success,
    ).toBe(false)
  })
})
