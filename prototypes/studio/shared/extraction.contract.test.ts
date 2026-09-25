import { describe, expect, it } from 'vitest'
import {
  extractionRequestSchema,
  extractionAttemptSchema,
  extractionModelChoiceSchema,
  extractionModelListingSchema,
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

  it('accepts service Catalog results without local stage diagnostics and validates stored diagnostics', () => {
    expect(
      extractionRequestSchema.safeParse({
        id: id('1'),
        sourceRepresentationRevisionId: id('3'),
        schemaRevisionId: id('4'),
        strategy: 'CATALOG',
      }).success,
    ).toBe(true)

    // The service reports calls and issues, not the former local pipeline's stages.
    expect(
      extractionAttemptSchema.safeParse({
        ...completed,
        strategy: 'CATALOG',
        modelAttribution: { provider: 'kei-exp', modelId: 'fixture' },
      }).success,
    ).toBe(true)
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

  it('accepts fresh requests and refuses retry fields', () => {
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
  })
})

describe('numbered-catalogue recipe contracts', () => {
  const fresh = { id: id('1'), sourceRepresentationRevisionId: id('3'), schemaRevisionId: id('4') }

  it('accepts a recipe only on a Catalog request, and only in the id@version form', () => {
    expect(extractionRequestSchema.parse({ ...fresh, strategy: 'CATALOG', catalogRecipe: 'numbered-catalogue-de@1' }))
      .toMatchObject({ catalogRecipe: 'numbered-catalogue-de@1' })
    expect(extractionRequestSchema.parse({ ...fresh, strategy: 'CATALOG' })).not.toHaveProperty('catalogRecipe')
    expect(extractionRequestSchema.safeParse({ ...fresh, strategy: 'ARTICLE', catalogRecipe: 'numbered-catalogue-de@1' }).success)
      .toBe(false)
    expect(extractionRequestSchema.safeParse({ ...fresh, strategy: 'CATALOG', catalogRecipe: '../etc' }).success).toBe(false)
  })

  it('carries version 2 review material: span evidence, proposals, rejections, coverage and completeness', () => {
    const grounding = {
      linkedBy: 'key', provenance: 'token', textSpans: [{ segment: 'p1_s2', start: 28, end: 32 }],
      keySpans: [{ segment: 'p1_s2', start: 23, end: 27 }], alternatives: [], heading: null, precision: 'segment',
      raw: '1827', normalized: { value: 'Meßtischblatt 1827', rule: 'glossary',
                                 keySpan: { segment: 'p1_s0', start: 0, end: 4 },
                                 expansionSpan: { segment: 'p1_s0', start: 7, end: 20 } },
    }
    const grounded = {
      recipe: 'numbered-catalogue-de@1', segmentationFingerprint: 'f',
      budget: { inputTokens: 4096, outputTokens: 1024, tokenizer: { source: 'vllm:/tokenize' } },
      segmentationDiagnostics: [],
      normalization: { version: 1, rules: ['glossary'] },
      recordBlocks: [{ block: 'b1', entry_label: '31' }],
      proposed: [{ path: ['records', 0, 'site_name'], value: 'Eichdorf', quote: 'Eichdorf', key: null,
                   provenance: 'positional', spans: [{ segment: 'p1_s2', start: 4, end: 12 }], alternatives: [], window: 0 }],
      rejected: [{ path: ['records', 0, 'fundart'], value: 'Siedl.', quote: 'FA: Siedl.', key: 'FA:', provenance: 'token',
                   spans: [], alternatives: [], window: 0, reason: 'quote_not_in_entry' }],
      competitors: [],
      coverage: { complete: false, unresolved: 1, lines: 12 },
      completeness: { processing: true, coverage: false, grounding: true, recall: 'unmeasured' },
    }
    const parsed = extractionAttemptSchema.parse({
      ...completed, strategy: 'CATALOG', complete: false,
      resultPayload: { records: [{ mbl_old: 1827 }] },
      evidenceLinks: [{ resultPath: ['records', 0, 'mbl_old'], evidenceAnchorId: 'a_p1_s2', verbatim: true,
                        lexicalHits: 1, grounding }],
      diagnostics: { ...completed.diagnostics, grounded },
    })
    expect(parsed.evidenceLinks![0].grounding).toEqual(grounding)
    expect(parsed.diagnostics!.grounded).toEqual(grounded)
  })
})

describe('Extraction Model Choice contracts', () => {
  const fresh = { id: id('1'), sourceRepresentationRevisionId: id('3'), schemaRevisionId: id('4'), strategy: 'ARTICLE' }

  it('never takes a model choice from the client: the server applies the configured one', () => {
    expect(extractionRequestSchema.parse(fresh)).not.toHaveProperty('models')
    for (const models of [{ fields: 'nuextract', reasoning: 'instruct' }, {}, 'instruct'])
      expect(extractionRequestSchema.safeParse({ ...fresh, models }).success).toBe(false)
    expect(extractionRequestSchema.safeParse({ ...fresh, model: 'instruct' }).success).toBe(false)
  })

  it('accepts a choice of kei-exp model keys for either role, and nothing else', () => {
    expect(extractionModelChoiceSchema.parse({ fields: 'nuextract', reasoning: 'instruct' }))
      .toEqual({ fields: 'nuextract', reasoning: 'instruct' })
    for (const models of [{ fields: '' }, { reasoning: 7 }, { fields: 'instruct', planner: 'instruct' }, 'instruct'])
      expect(extractionModelChoiceSchema.safeParse(models).success).toBe(false)
  })

  it('echoes the requested choice and the models kei-exp resolved per role beside the unchanged attribution', () => {
    const parsed = extractionAttemptSchema.parse({
      ...completed,
      modelAttribution: { provider: 'kei-exp', modelId: 'numind/NuExtract3-FP8' },
      requestedModels: { fields: 'nuextract' },
      diagnostics: { ...completed.diagnostics, models: { fields: 'numind/NuExtract3-FP8', reasoning: 'Qwen/Qwen3.8-27B-FP8' } },
    })
    expect(parsed.requestedModels).toEqual({ fields: 'nuextract' })
    expect(parsed.diagnostics!.models).toEqual({ fields: 'numind/NuExtract3-FP8', reasoning: 'Qwen/Qwen3.8-27B-FP8' })
    expect(extractionAttemptSchema.parse({ ...completed, requestedModels: null }).requestedModels).toBeNull()
    expect(extractionAttemptSchema.safeParse({
      ...completed, diagnostics: { ...completed.diagnostics, models: { fields: 'numind/NuExtract3-FP8' } },
    }).success).toBe(false)
  })

  it('reads the kei-exp deployment listing of extraction models, roles and defaults', () => {
    const listing = {
      defaults: { fields: 'nuextract', reasoning: 'instruct' },
      models: [
        { key: 'instruct', repo: 'Qwen/Qwen3.8-27B-FP8', roles: ['fields', 'reasoning'], reachable: true, serving: true },
        { key: 'nuextract', repo: 'numind/NuExtract3-FP8', roles: ['fields'], reachable: false, serving: false },
      ],
    }
    expect(extractionModelListingSchema.parse(listing)).toEqual(listing)
    expect(extractionModelListingSchema.safeParse({ ...listing, models: [{ ...listing.models[0], roles: ['planner'] }] }).success)
      .toBe(false)
    expect(extractionModelListingSchema.safeParse({ defaults: { fields: 'nuextract' }, models: [] }).success).toBe(false)
  })
})
