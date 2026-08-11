import { describe, expect, it } from 'vitest'
import type {
  ProjectStore,
  StoredExtractionAttempt,
  TerminalExtractionInput,
} from '../../../packages/db/src/project-store.js'
import parsedDocument from '../src/assets/parsed_document.v2.json'
import {
  extractionAttemptSchema,
  type ExtractionAttempt,
} from '../shared/extraction.contract.js'
import type { SchemaDefinition } from '../shared/schemaNode.js'
import { createExtractionsApi } from './extractions.js'
import type { NuExtractRawExecutionTarget } from './_provider.js'

const ARTICLE_SMOKE = process.env.FREE_LIVE_ARTICLE_SMOKE === '1'
const TIMEOUT_MS = 12 * 60 * 1_000
const sourceDocumentId = '22222222-2222-4222-8222-222222222222'
const representationId = '33333333-3333-4333-8333-333333333333'
const schemaRevisionId = '44444444-4444-4444-8444-444444444444'

function ollamaTarget(): NuExtractRawExecutionTarget {
  const model =
    process.env.FREE_LIVE_OLLAMA_MODEL ??
    'hf.co/numind/NuExtract3-GGUF:Q4_K_M'
  return {
    profile: 'nuextract-raw',
    modelId: model,
    baseUrl: process.env.FREE_LIVE_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    authorization: null,
    temperatureSupported: true,
    attribution: { provider: 'ollama', modelId: model },
  }
}

async function runProviderSmoke(input: {
  extractionId: string
  schemaTree?: SchemaDefinition
}): Promise<ExtractionAttempt> {
  const schemaTree: SchemaDefinition = input.schemaTree ?? {
    recordDescription: 'One article described by this Source Document.',
    schemaNodes: [
      {
        id: 'title',
        name: 'title',
        type: 'string',
        description: 'The article title stated in the text.',
      },
    ],
  }
  let persisted: TerminalExtractionInput | null = null
  const store = {
    getExtractionAttempt: async () => null,
    getExtractionInputs: async () => ({
      sourceDocumentId,
      projectContextId: '55555555-5555-4555-8555-555555555555',
      sourceRepresentationId: representationId,
      sourceRepresentationRevisionId: representationId,
      schemaRevisionId,
      extractionSchemaId: '66666666-6666-4666-8666-666666666666',
      schemaTree,
      descriptor: {
        artifactReference: 'a'.repeat(64),
        artifactSha256: 'a'.repeat(64),
      },
    }),
    persistExtractionAttempt: async (terminal: TerminalExtractionInput) => {
      persisted = terminal
      const attempt: StoredExtractionAttempt = {
        ...terminal,
        sourceRepresentationRevisionNumber: 1,
        extractionSchemaId: '66666666-6666-4666-8666-666666666666',
        schemaRevisionNumber: 1,
        schemaTree,
        createdAt: new Date(),
        reviewedAt: null,
        reviewDecisions: [],
      }
      return { status: 'created' as const, attempt }
    },
    getExtractionAttemptForOwner: async () => persisted,
    reviewExtractionAttempt: async () => null,
  } as unknown as ProjectStore
  const response = await createExtractionsApi({
    store,
    readSource: async () => parsedDocument,
    resolveTarget: async () => ollamaTarget(),
  })(
    new Request('http://localhost/api/extractions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: input.extractionId,
        sourceRepresentationRevisionId: representationId,
        schemaRevisionId,
        strategy: 'ARTICLE',
      }),
    }),
  )
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(201)
  return extractionAttemptSchema.parse(body)
}

function logAttempt(source: string, startedAt: number, attempt: ExtractionAttempt) {
  console.info(
    JSON.stringify({
      source,
      provider: attempt.modelAttribution?.provider,
      model: attempt.modelAttribution?.modelId,
      durationMs: Date.now() - startedAt,
      outcome: attempt.outcome,
      complete: attempt.complete,
      reviewable: attempt.reviewable,
      modelCalls: attempt.diagnostics.modelCalls,
      records: Array.isArray(attempt.resultPayload?.records)
        ? attempt.resultPayload.records.length
        : 0,
    }),
  )
}

describe.skipIf(!ARTICLE_SMOKE)('production-path Article provider smoke', () => {
  it('persists a complete reviewable Article attempt through POST /api/extractions', { timeout: TIMEOUT_MS }, async () => {
    const startedAt = Date.now()
    const attempt = await runProviderSmoke({
      extractionId: '11111111-1111-4111-8111-111111111111',
    })
    logAttempt('bundled-article', startedAt, attempt)
    expect(attempt).toMatchObject({
      strategy: 'ARTICLE',
      outcome: 'SUCCEEDED',
      complete: true,
      reviewable: true,
      resultPayload: {
        records: [expect.objectContaining({ title: expect.any(String) })],
      },
    })
  })
})
