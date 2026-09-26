import { describe, expect, it, vi } from 'vitest'
import { ExtractionError, type KeiExpClient } from 'extraction'
import { ingestionModelListingSchema } from '../shared/modelConfig.contract.js'
import { createGetIngestionModels, createResearcherApiHandlers } from './ingestion_models.js'

const runtime = vi.hoisted(() => ({ listIngestionModels: vi.fn() }))
vi.mock('./_extraction_runtime.js', () => ({ keiExpClient: { listIngestionModels: runtime.listIngestionModels } }))

const listing = {
  defaults: { ocr: 'surya', layout: 'layout_heron_101' },
  models: {
    ocr: [
      { key: 'surya', label: 'datalab-to/surya-ocr-2', serving: true },
      { key: 'granite_docling', label: 'ibm-granite/granite-docling-258M', serving: false },
    ],
    layout: [
      { key: 'layout_heron_default', label: 'Heron', serving: true },
      { key: 'layout_heron_101', label: 'Heron-101', serving: true },
    ],
  },
}
const copy = () => structuredClone(listing)
const get = (path = '/api/ingestion-models', init?: RequestInit) => new Request(`https://studio.example${path}`, init)

describe('GET /api/ingestion-models', () => {
  it('serves kei\'s listing unchanged', async () => {
    const response = await createGetIngestionModels({ listIngestionModels: async () => copy() })(get())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body: unknown = await response.json()
    expect(body).toEqual(listing)
    expect(ingestionModelListingSchema.parse(body)).toEqual(listing)
  })

  it('answers 503 ingestion_models_unavailable with no-store when kei is unreachable or answers an invalid listing', async () => {
    const failures: Array<KeiExpClient['listIngestionModels']> = [
      async () => { throw new ExtractionError('model_unavailable', 'kei-exp could not be reached to list its ingestion models: fetch failed') },
      async () => { throw new ExtractionError('invalid_model_output', 'kei-exp returned an invalid ingestion model listing.') },
      // A listing the Studio contract refuses even though the client accepted it: a key longer than 128 characters.
      async () => ({ ...copy(), defaults: { ocr: 'x'.repeat(129), layout: 'layout_heron_101' } }),
    ]
    for (const listIngestionModels of failures) {
      const response = await createGetIngestionModels({ listIngestionModels })(get())
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const body = await response.json()
      expect(body.error.code).toBe('ingestion_models_unavailable')
      expect(body.error.message).toBe('The Parsing Service could not list its ingestion models.')
      expect(JSON.stringify(body)).not.toContain('fetch failed')
    }
  })

  it('forwards the request\'s abort signal', async () => {
    const controller = new AbortController()
    const listIngestionModels = vi.fn<KeiExpClient['listIngestionModels']>(async () => copy())
    await createGetIngestionModels({ listIngestionModels })(get(undefined, { signal: controller.signal }))
    const [forwarded] = listIngestionModels.mock.calls[0]
    expect(forwarded).toBeInstanceOf(AbortSignal)
    expect(forwarded?.aborted).toBe(false)
    controller.abort()
    expect(forwarded?.aborted).toBe(true)
  })

  it('answers 404 for any other path', async () => {
    runtime.listIngestionModels.mockResolvedValue(copy())
    const handlers = createResearcherApiHandlers()
    expect(Object.keys(handlers)).toEqual(['GET'])
    expect((await handlers.GET(get())).status).toBe(200)
    expect(runtime.listIngestionModels).toHaveBeenCalledTimes(1)
    for (const path of ['/api/ingestion_models', '/api/ingestion-models/surya'])
      expect((await handlers.GET(get(path))).status).toBe(404)
    expect(runtime.listIngestionModels).toHaveBeenCalledTimes(1)
  })
})
