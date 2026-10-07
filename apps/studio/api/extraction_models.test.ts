import { describe, expect, it, vi } from 'vitest'
import { ExtractionError, type KeiExpClient } from 'extraction'
import { extractionModelListingSchema } from '../shared/extraction.contract.js'
import { createGetExtractionModels, createResearcherApiHandlers } from './extraction_models.js'

const runtime = vi.hoisted(() => ({ listModels: vi.fn() }))
vi.mock('./_extractions.js', () => ({ keiExpClient: { listModels: runtime.listModels } }))

const listing = {
  defaults: { fields: 'nuextract', reasoning: 'instruct' },
  models: [
    { key: 'instruct', repo: 'Qwen/Qwen3.8-27B-FP8', roles: ['fields', 'reasoning'] as const, reachable: true, serving: true },
    { key: 'nuextract', repo: 'numind/NuExtract3-FP8', roles: ['fields'] as const, reachable: false, serving: false },
  ],
}
const get = (path = '/api/extraction-models') => new Request(`https://studio.example${path}`)

describe('GET /api/extraction-models', () => {
  it('relays the kei-exp deployment\'s extraction models, roles and defaults without caching them', async () => {
    const listModels = vi.fn<KeiExpClient['listModels']>(async () => ({ ...listing, models: listing.models.map((model) => ({ ...model, roles: [...model.roles] })) }))
    const response = await createGetExtractionModels({ listModels })(get())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(extractionModelListingSchema.parse(await response.json())).toEqual(listing)
    expect(listModels).toHaveBeenCalledWith(expect.any(AbortSignal))
  })

  it('answers 503 when kei-exp cannot list its models, so the choice falls back to the defaults', async () => {
    for (const failure of [
      new ExtractionError('model_unavailable', 'kei-exp returned HTTP 503: the store is down'),
      new ExtractionError('invalid_model_output', 'kei-exp returned an invalid extraction model listing.'),
    ]) {
      const response = await createGetExtractionModels({ listModels: async () => { throw failure } })(get())
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect((await response.json()).error.code).toBe('extraction_models_unavailable')
    }
  })

  it('serves only its own path, through the shared kei-exp client, for any signed-in researcher', async () => {
    runtime.listModels.mockResolvedValue(listing)
    const handlers = createResearcherApiHandlers()
    expect(Object.keys(handlers)).toEqual(['GET'])
    expect((await handlers.GET(get())).status).toBe(200)
    expect(runtime.listModels).toHaveBeenCalledTimes(1)
    expect((await handlers.GET(get('/api/extraction_models'))).status).toBe(404)
  })
})
