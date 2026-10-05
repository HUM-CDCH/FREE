import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ExtractionError } from './errors.js'
import { createKeiExpClient } from './kei-exp.js'

const json = (body: unknown, status = 200, headers?: Record<string, string>) => Response.json(body, { status, headers })

describe('kei-exp model listings', () => {
  it('lists the deployment\'s extraction models, their roles and the default per role', async () => {
    const listing = {
      defaults: { fields: 'nuextract', reasoning: 'instruct' },
      models: [
        { key: 'instruct', repo: 'Qwen/Qwen3.8-27B-FP8', roles: ['fields', 'reasoning'], reachable: true, serving: true },
        { key: 'nuextract', repo: 'numind/NuExtract3-FP8', roles: ['fields'], reachable: true, serving: false },
      ],
    }
    const requests: string[] = []
    const client = (response: Response | Error) => createKeiExpClient({
      url: 'http://kei-exp:8001/',
      fetch: async (url, init) => {
        requests.push(`${init?.method ?? 'GET'} ${String(url)}`)
        if (response instanceof Error) throw response
        return response
      },
    })
    assert.deepEqual(await client(json(listing)).listModels(new AbortController().signal), listing)
    assert.deepEqual(requests, ['GET http://kei-exp:8001/api/extraction-models'])
    await assert.rejects(client(json({ detail: 'the store is down' }, 503)).listModels(), (error: unknown) =>
      error instanceof ExtractionError && error.code === 'model_unavailable' && error.message.includes('the store is down'))
    await assert.rejects(client(new TypeError('fetch failed')).listModels(), (error: unknown) =>
      error instanceof ExtractionError && error.code === 'model_unavailable' && error.message.includes('fetch failed'))
    for (const invalid of [json({ models: [] }), json({ ...listing, models: [{ key: 'x' }] }), new Response('not json')])
      await assert.rejects(client(invalid).listModels(), { code: 'invalid_model_output' })
  })

  it('listIngestionModels reads kei\'s listing and refuses an invalid one', async () => {
    const listing = {
      defaults: { ocr: 'surya', layout: 'layout_heron_101' },
      models: {
        ocr: [
          { key: 'surya', label: 'datalab-to/surya-ocr-2', serving: true },
          { key: 'granite_docling', label: 'ibm-granite/granite-docling-258M', serving: false },
        ],
        layout: [{ key: 'layout_heron_101', label: 'Heron-101', serving: true }],
      },
    }
    const requests: string[] = []
    const client = (response: Response | Error) => createKeiExpClient({
      url: 'http://kei-exp:8001/',
      fetch: async (url, init) => {
        requests.push(`${init?.method ?? 'GET'} ${String(url)}`)
        if (response instanceof Error) throw response
        return response
      },
    })
    assert.deepEqual(await client(json(listing)).listIngestionModels(new AbortController().signal), listing)
    assert.deepEqual(requests, ['GET http://kei-exp:8001/api/ingestion-models'])
    await assert.rejects(client(json({ detail: 'the OCR server is down' }, 503)).listIngestionModels(), (error: unknown) =>
      error instanceof ExtractionError && error.code === 'model_unavailable' && error.message.includes('the OCR server is down'))
    await assert.rejects(client(new TypeError('fetch failed')).listIngestionModels(), (error: unknown) =>
      error instanceof ExtractionError && error.code === 'model_unavailable'
      && error.message.includes('kei-exp could not be reached to list its ingestion models') && error.message.includes('fetch failed'))
    const { defaults: _, ...withoutDefaults } = listing
    for (const invalid of [json(withoutDefaults), json({ ...listing, models: { ...listing.models, ocr: [{ key: 'surya' }] } }), new Response('not json')])
      await assert.rejects(client(invalid).listIngestionModels(), { code: 'invalid_model_output' })
    await assert.rejects(client(json(withoutDefaults)).listIngestionModels(), { message: 'kei-exp returned an invalid ingestion model listing.' })
  })
})
