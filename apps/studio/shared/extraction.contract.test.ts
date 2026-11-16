import { REFERENCE_ARTICLE } from 'extraction/extraction-method'
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
const ARTICLE_DEFAULTS = { models: null, settings: { article: REFERENCE_ARTICLE } } as const
const CATALOG_DEFAULTS = { models: null, settings: { unified: { defaults: 10 } } } as const

const completed = {
  extractionId: id('1'),
  sourceDocumentId: id('2'),
  sourceRepresentationRevisionId: id('3'),
  schemaRevisionId: id('4'),
  strategy: 'ARTICLE',
  requestedModels: null,
  requestedSettings: { article: REFERENCE_ARTICLE },
  executionStatus: 'COMPLETED',
  finalizedReview: null,
  batchExtractionId: null,
  createdAt: '2026-08-10T00:00:00.000Z',
} as const

describe('durable Extraction contracts', () => {
  it('carries every durable lifecycle state with no result, review or failure fields', () => {
    for (const executionStatus of ['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING', 'STOPPED', 'COMPLETED', 'FAILED'] as const)
      expect(extractionAttemptSchema.parse({ ...completed, executionStatus }).executionStatus).toBe(executionStatus)
    for (const removed of [{ resultPayload: null }, { evidenceLinks: [] }, { reviewDecisions: [] }, { reviewedAt: null },
      { outcome: 'SUCCEEDED' }, { diagnostics: null }, { failure: null }, { durable: true }])
      expect(extractionAttemptSchema.safeParse({ ...completed, ...removed }).success).toBe(false)
  })

  it('names its latest finalized result and decision cut, or null', () => {
    const finalizedReview = { snapshotVersion: 3, feedbackVersion: 0, createdAt: '2026-10-05T09:00:00.000Z' }
    expect(extractionAttemptSchema.parse({ ...completed, finalizedReview }).finalizedReview).toEqual(finalizedReview)
    for (const wrong of [{ ...finalizedReview, snapshotVersion: 0 }, { ...finalizedReview, feedbackVersion: -1 }, { snapshotVersion: 3, feedbackVersion: 0 }])
      expect(extractionAttemptSchema.safeParse({ ...completed, finalizedReview: wrong }).success).toBe(false)
  })

  it('records its admitted settings and no Catalog recipe', () => {
    expect(extractionAttemptSchema.safeParse({ ...completed, catalogRecipe: 'numbered-catalogue-de@1' }).success).toBe(false)
    expect(extractionAttemptSchema.parse({ ...completed, requestedSettings: { article: REFERENCE_ARTICLE } }).requestedSettings).toEqual({ article: REFERENCE_ARTICLE })
    expect(extractionAttemptSchema.safeParse({ ...completed, requestedSettings: { article: REFERENCE_ARTICLE, generic: null } }).success).toBe(false)
  })
})

describe('Extraction request contracts', () => {


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

})

describe('Catalog request contracts', () => {
  const fresh = { id: id('1'), sourceRepresentationRevisionId: id('3'), schemaRevisionId: id('4') }

  it('Catalog accepts unified settings and refuses recipe and generic request shapes', () => {
   expect(extractionRequestSchema.parse({ ...fresh, strategy: 'CATALOG', method: CATALOG_DEFAULTS }).method).toEqual(CATALOG_DEFAULTS)
   for (const settings of [{ recipe: null }, { generic: null }]) expect(extractionRequestSchema.safeParse({ ...fresh, strategy: 'CATALOG', method: { models: null, settings } }).success).toBe(false)
   expect(extractionRequestSchema.safeParse({ ...fresh, strategy: 'CATALOG', method: CATALOG_DEFAULTS, catalogRecipe: 'numbered-catalogue-de@1' }).success).toBe(false)
 })

  it("requires the saved method, with only the settings of the request's strategy", () => {
    for (const [strategy, method] of [
      ['ARTICLE', ARTICLE_DEFAULTS],
      ['CATALOG', CATALOG_DEFAULTS],
    ] as const) {
      const request = { ...fresh, strategy,  }
      expect(extractionRequestSchema.parse({ ...request, method }).method).toEqual(method)
      expect(extractionRequestSchema.safeParse(request).success).toBe(false)
    }
    expect(extractionRequestSchema.safeParse({ ...fresh, strategy: 'ARTICLE', method: CATALOG_DEFAULTS }).success).toBe(false)
    expect(extractionRequestSchema.safeParse({
      ...fresh, strategy: 'CATALOG', method: ARTICLE_DEFAULTS,
    }).success).toBe(false)
  })

  it('refuses a method that breaks a rule of the method contract at the field that breaks it', () => {
    const article = { context: 'full', grounding: 'off', grounding_overflow: 'windows' }
    const parsed = extractionRequestSchema.safeParse({ ...fresh, strategy: 'ARTICLE', method: { models: null, settings: { article } } })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues).toContainEqual(expect.objectContaining({
      path: ['method', 'settings', 'article', 'grounding_overflow'],
      message: 'Choose a verification method to check large claims in windows.',
    }))
  })

})

describe('Extraction Model Choice contracts', () => {
  const fresh = {
    id: id('1'), sourceRepresentationRevisionId: id('3'), schemaRevisionId: id('4'), strategy: 'ARTICLE', method: ARTICLE_DEFAULTS,
  }

  it('takes a model choice only inside the saved method', () => {
    expect(extractionRequestSchema.parse(fresh)).not.toHaveProperty('models')
    expect(extractionRequestSchema.parse({ ...fresh, method: { ...ARTICLE_DEFAULTS, models: { fields: 'nuextract' } } }).method)
      .toEqual({ models: { fields: 'nuextract' }, settings: { article: REFERENCE_ARTICLE } })
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
