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
  executionStatus: 'QUEUED',
  phase: 'SOURCES',
  proposal: null,
  coverage: null,
  draft: definition,
  draftVersion: 0,
  failure: null,
  confirmedSchemaRevisionId: null,
  batchExtractionId: null,
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-08-15T10:00:00.000Z',
  sources: [
    {
      sourceDocumentId,
      sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
      executionStatus: 'QUEUED',
      definition: null,
      failure: null,
      startedAt: null,
      finishedAt: null,
    },
  ],
}

let requests: string[]

beforeEach(() => {
  requests = []
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
    await retryBatchSchemaSuggestion(projectContextId, batchSchemaSuggestionId)

    expect(requests).toEqual([
      'PUT /api/model-keys',
      'POST /api/batch-schema-suggestions',
      'PUT /api/model-keys',
      `POST /api/batch-schema-suggestions/${batchSchemaSuggestionId}/retry`,
    ])
  })

  it('running a suggestion starts no Studio model work and sends no keys', async () => {
    await runBatchSchemaSuggestion(projectContextId, batchSchemaSuggestionId, 'ARTICLE')

    expect(requests).toEqual([`POST /api/batch-schema-suggestions/${batchSchemaSuggestionId}/run`])
  })
})
