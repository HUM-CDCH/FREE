import { describe, expect, it } from 'vitest'
import {
  extractionRequestSchema,
  extractionAttemptSchema,
  extractionModelChoiceSchema,
  extractionModelListingSchema,
} from './extraction.contract.js'

const id = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`

/** The saved method a start view submits when the account keeps every service default, per settings slot. */
const ARTICLE_DEFAULTS = { models: null, settings: { article: null } } as const
const GENERIC_DEFAULTS = { models: null, settings: { generic: null } } as const
const RECIPE_DEFAULTS = { models: null, settings: { recipe: null } } as const

const completed = {
  extractionId: id('1'),
  sourceDocumentId: id('2'),
  sourceRepresentationRevisionId: id('3'),
  schemaRevisionId: id('4'),
  strategy: 'ARTICLE',
  catalogRecipe: null,
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
  },
  failure: null,
  resultPayload: { records: [{}] },
  evidenceLinks: [],
  reviewable: true,
  batchExtractionId: null,
  createdAt: '2026-08-10T00:00:00.000Z',
  reviewedAt: null,
  reviewDecisions: [],
} as const

describe('Article lifecycle contracts', () => {
  it('accepts queued and running jobs only while they carry no values', () => {
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
    expect(extractionAttemptSchema.safeParse({ ...queued, executionStatus: 'RUNNING' }).success).toBe(true)
    expect(extractionAttemptSchema.safeParse({
      ...queued,
      executionStatus: 'RUNNING',
      complete: true,
      modelAttribution: completed.modelAttribution,
      diagnostics: completed.diagnostics,
      resultPayload: completed.resultPayload,
    }).success).toBe(false)
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
        method: ARTICLE_DEFAULTS,
        result: {},
      }).success,
    ).toBe(false)
  })

  it('a COMPLETED attempt is a succeeded result with its evidence and diagnostics', () => {
    expect(extractionAttemptSchema.safeParse(completed).success).toBe(true)
    for (const missing of ['diagnostics', 'complete', 'modelAttribution', 'resultPayload', 'evidenceLinks'] as const)
      expect(extractionAttemptSchema.safeParse({ ...completed, [missing]: null }).success).toBe(false)
    expect(extractionAttemptSchema.safeParse({ ...completed, outcome: null }).success).toBe(false)
    expect(extractionAttemptSchema.safeParse({
      ...completed,
      failure: { code: 'extraction_failed', message: 'Failed.' },
    }).success).toBe(false)
  })

  it('a failed, cancelled or interrupted attempt is FAILED with a failure and no result', () => {
    const failed = {
      ...completed,
      executionStatus: 'FAILED',
      outcome: null,
      complete: null,
      modelAttribution: null,
      diagnostics: null,
      resultPayload: null,
      evidenceLinks: null,
      reviewable: false,
    }
    for (const failure of [
      { code: 'extraction_failed', message: 'The model was unreachable.' },
      { code: 'cancelled', message: 'Extraction cancelled.' },
      { code: 'interrupted', message: 'This work stopped before it finished. Start it again.' },
    ]) {
      expect(extractionAttemptSchema.safeParse({ ...failed, failure }).success).toBe(true)
      // The job-era shape of a settled failure: COMPLETED with a FAILED or CANCELLED outcome.
      for (const outcome of ['FAILED', 'CANCELLED'] as const)
        expect(extractionAttemptSchema.safeParse({
          ...failed,
          executionStatus: 'COMPLETED',
          outcome,
          diagnostics: completed.diagnostics,
          failure,
        }).success).toBe(false)
      expect(extractionAttemptSchema.safeParse({ ...failed, outcome: 'FAILED', failure }).success).toBe(false)
      expect(extractionAttemptSchema.safeParse({
        ...failed,
        failure,
        diagnostics: completed.diagnostics,
      }).success).toBe(false)
    }
    expect(extractionAttemptSchema.safeParse({ ...failed, failure: null }).success).toBe(false)
  })

  it('an attempt names its Catalog recipe, or null', () => {
    const catalog = { ...completed, strategy: 'CATALOG' }
    expect(extractionAttemptSchema.parse({ ...catalog, catalogRecipe: 'numbered-catalogue-de@1' }))
      .toMatchObject({ catalogRecipe: 'numbered-catalogue-de@1' })
    expect(extractionAttemptSchema.safeParse({ ...catalog, catalogRecipe: null }).success).toBe(true)
    const unnamed: Partial<typeof catalog> = { ...catalog }
    delete unnamed.catalogRecipe
    expect(extractionAttemptSchema.safeParse(unnamed).success).toBe(false)
    expect(extractionAttemptSchema.safeParse({ ...catalog, catalogRecipe: '../etc' }).success).toBe(false)
    expect(extractionAttemptSchema.safeParse({ ...completed, catalogRecipe: 'numbered-catalogue-de@1' }).success)
      .toBe(false)
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
        method: GENERIC_DEFAULTS,
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
      method: ARTICLE_DEFAULTS,
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
        method: ARTICLE_DEFAULTS,
        retryOfId: id('5'),
      }).success,
    ).toBe(false)
  })

  it('carries no retry lineage on attempts or diagnostics', () => {
    expect(extractionAttemptSchema.safeParse({ ...completed, retryOfId: null }).success).toBe(false)
    expect(extractionAttemptSchema.safeParse({
      ...completed,
      diagnostics: { ...completed.diagnostics, retry: null },
    }).success).toBe(false)
  })
})

describe('numbered-catalogue recipe contracts', () => {
  const fresh = { id: id('1'), sourceRepresentationRevisionId: id('3'), schemaRevisionId: id('4') }

  it('accepts a recipe only on a Catalog request, and only in the id@version form', () => {
    expect(extractionRequestSchema.parse({
      ...fresh, strategy: 'CATALOG', catalogRecipe: 'numbered-catalogue-de@1', method: RECIPE_DEFAULTS,
    })).toMatchObject({ catalogRecipe: 'numbered-catalogue-de@1' })
    expect(extractionRequestSchema.parse({ ...fresh, strategy: 'CATALOG', method: GENERIC_DEFAULTS }))
      .not.toHaveProperty('catalogRecipe')
    expect(extractionRequestSchema.safeParse({
      ...fresh, strategy: 'ARTICLE', catalogRecipe: 'numbered-catalogue-de@1', method: ARTICLE_DEFAULTS,
    }).success).toBe(false)
    expect(extractionRequestSchema.safeParse({
      ...fresh, strategy: 'CATALOG', catalogRecipe: '../etc', method: RECIPE_DEFAULTS,
    }).success).toBe(false)
  })

  it("requires the saved method, with only the settings of the request's strategy", () => {
    for (const [strategy, catalogRecipe, method] of [
      ['ARTICLE', undefined, ARTICLE_DEFAULTS],
      ['CATALOG', undefined, GENERIC_DEFAULTS],
      ['CATALOG', 'numbered-catalogue-de@1', RECIPE_DEFAULTS],
    ] as const) {
      const request = { ...fresh, strategy, ...(catalogRecipe ? { catalogRecipe } : {}) }
      expect(extractionRequestSchema.parse({ ...request, method }).method).toEqual(method)
      expect(extractionRequestSchema.safeParse(request).success).toBe(false)
    }
    expect(extractionRequestSchema.safeParse({ ...fresh, strategy: 'ARTICLE', method: GENERIC_DEFAULTS }).success).toBe(false)
    expect(extractionRequestSchema.safeParse({
      ...fresh, strategy: 'CATALOG', catalogRecipe: 'numbered-catalogue-de@1', method: ARTICLE_DEFAULTS,
    }).success).toBe(false)
  })

  it('refuses a method that breaks a rule of the method contract at the field that breaks it', () => {
    const article = { context: 'full', grounding: 'semantic', grounding_schedule: 'unresolved', grounding_routing: 'origin_lexical' }
    const parsed = extractionRequestSchema.safeParse({ ...fresh, strategy: 'ARTICLE', method: { models: null, settings: { article } } })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues).toContainEqual(expect.objectContaining({
      path: ['method', 'settings', 'article', 'grounding_routing'],
      message: 'Use generated quotes or source spans, and stop after support.',
    }))
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
  const fresh = {
    id: id('1'), sourceRepresentationRevisionId: id('3'), schemaRevisionId: id('4'), strategy: 'ARTICLE', method: ARTICLE_DEFAULTS,
  }

  it('takes a model choice only inside the saved method', () => {
    expect(extractionRequestSchema.parse(fresh)).not.toHaveProperty('models')
    expect(extractionRequestSchema.parse({ ...fresh, method: { ...ARTICLE_DEFAULTS, models: { fields: 'nuextract' } } }).method)
      .toEqual({ models: { fields: 'nuextract' }, settings: { article: null } })
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

describe('Method used contracts', () => {
  const effectiveMethod = { options: { strategy: 'article', article: { context: 'full', grounding: 'quoted' } }, versions: { prompt: 12, method: 1 } }
  const eligibility = { allRecordLeaves: 3, eligibleRecordLeaves: 0, eligibleGrounding: 'not_applicable',
    skipped: [{ resultPath: ['records', 0, 'year'], policy: 'unverified' }] }
  const support = [{ resultPath: ['records', 0, 'title'], segment: 'p1_s0', cell: 'r0_c1', quote: 'Alpha', attribution: 'model_attested' }]

  it('carries the admitted settings, or null for a run that predates them', () => {
    expect(extractionAttemptSchema.parse({ ...completed, requestedSettings: { article: null } }).requestedSettings).toEqual({ article: null })
    expect(extractionAttemptSchema.parse({ ...completed, requestedSettings: null }).requestedSettings).toBeNull()
    expect(extractionAttemptSchema.safeParse({ ...completed, requestedSettings: { article: null, generic: null } }).success).toBe(false)
  })

  it('carries the effective method, schema-policy accounting and support proofs, or null, and nothing unknown', () => {
    const diagnostics = { ...completed.diagnostics, effectiveMethod, eligibility, support }
    expect(extractionAttemptSchema.parse({ ...completed, diagnostics }).diagnostics).toEqual(diagnostics)
    const none = { ...completed.diagnostics, effectiveMethod: null, eligibility: null, support: null }
    expect(extractionAttemptSchema.parse({ ...completed, diagnostics: none }).diagnostics).toEqual(none)
    for (const wrong of [
      { effectiveMethod: { ...effectiveMethod, versions: { prompt: 'v12' } } },
      { eligibility: { ...eligibility, eligibleGrounding: 'fully_grounded' } },
      { eligibility: { ...eligibility, skipped: [{ resultPath: ['records', 0, 'year'], policy: 'quoted' }] } },
      { support: [{ ...support[0], start: -1 }] },
      { support: [{ ...support[0], evidenceAnchorId: 'a_p1_s0' }] },
    ]) expect(extractionAttemptSchema.safeParse({ ...completed, diagnostics: { ...completed.diagnostics, ...wrong } }).success).toBe(false)
  })
})
