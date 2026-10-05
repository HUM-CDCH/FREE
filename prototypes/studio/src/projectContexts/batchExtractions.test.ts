// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setModelKeyAccount } from '../modelKeys/modelKeyHandoff'
import { saveModelKey } from '../modelKeys/modelKeyStore'
import {
  createBatchSchemaSuggestion,
  retryBatchSchemaSuggestion,
  runBatchSchemaSuggestion,
} from './batchExtractions'

const ACCOUNT = '10000000-0000-4000-8000-000000000001'
const projectContextId = '51000000-0000-4000-8000-000000000001'
const sourceDocumentId = '51000000-0000-4000-8001-000000000001'
const batchSchemaSuggestionId = '51000000-0000-4000-8008-000000000001'
const definition = {
  recordDescription: 'One record.',
  schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
}
const suggestion = {
  batchSchemaSuggestionId,
  projectContextId,
  selectionKey: 'a'.repeat(64),
  attempt: 2,
  executionStatus: 'QUEUED',
  phase: 'READY',
  sourceKind: 'DOCUMENTS',
  purpose: null,
  columnFieldMapping: null,
  projectSpreadsheetVersionId: null,
  proposal: definition,
  sourceCoverage: null,
  draft: definition,
  draftVersion: 1,
  failure: null,
  confirmedSchemaRevisionId: null,
  batchExtractionId: null,
  createdAt: '2026-08-15T10:00:00.000Z',
  sources: [
    {
      sourceDocumentId,
      sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
    },
  ],
}

let requests: string[]
let bodies: unknown[]

beforeEach(() => {
  requests = []
  bodies = []
  saveModelKey(
    ACCOUNT,
    { id: '11111111-1111-4111-8111-111111111111', provider: 'openai-compatible', baseUrl: 'https://a.example/v1' },
    'sk-test-batch',
  )
  setModelKeyAccount(ACCOUNT)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`)
      if (init?.body) bodies.push(JSON.parse(String(init.body)))
      if (url === '/api/model-keys') return Response.json({ accepted: [] })
      return Response.json({ batchSchemaSuggestion: suggestion })
    }),
  )
})

afterEach(() => {
  setModelKeyAccount(null)
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('Batch Schema Suggestion requests', () => {
  it('creating and retrying a batch suggestion send the keys first', async () => {
    await createBatchSchemaSuggestion(projectContextId, [sourceDocumentId])
    await retryBatchSchemaSuggestion(projectContextId, batchSchemaSuggestionId, 1)

    expect(requests).toEqual([
      'PUT /api/model-keys',
      'POST /api/batch-schema-suggestions',
      'PUT /api/model-keys',
      `POST /api/batch-schema-suggestions/${batchSchemaSuggestionId}/retry`,
    ])
    // The retry names the attempt it follows, so a repeated POST replays the successor instead of starting another.
    expect(bodies.at(-1)).toEqual({ expectedAttempt: 1 })
  })

  it('running a suggestion starts no Studio model work, sends no keys, and submits the saved method', async () => {
    const method = { models: { fields: 'instruct' }, settings: { generic: null } }
    await runBatchSchemaSuggestion(projectContextId, batchSchemaSuggestionId, 'CATALOG', method)

    expect(requests).toEqual([`POST /api/batch-schema-suggestions/${batchSchemaSuggestionId}/run`])
    expect(bodies.at(-1)).toEqual({ strategy: 'CATALOG', method })
  })
})
