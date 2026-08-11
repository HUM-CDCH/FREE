import { readFile } from 'node:fs/promises'
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
import type { ParsedDocument } from '../shared/parsedDocument.js'
import type { SchemaDefinition } from '../shared/schemaNode.js'
import { createExtractionsApi } from './extractions.js'
import type { NuExtractRawExecutionTarget } from './_provider.js'

const ARTICLE_SMOKE = process.env.FREE_LIVE_ARTICLE_SMOKE === '1'
const CATALOG_SMOKE = process.env.FREE_LIVE_CATALOG_SMOKE === '1'
const RETAINED_KIND = process.env.FREE_LIVE_CATALOG_KIND
const RETAINED_PATH = process.env.FREE_LIVE_CATALOG_RETAINED
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
  strategy: 'ARTICLE' | 'CATALOG'
  document?: unknown
  schemaTree?: SchemaDefinition
}): Promise<ExtractionAttempt> {
  const schemaTree: SchemaDefinition = input.schemaTree ?? {
    recordDescription: 'One article described by this Source Document.',
    schemaNodes: [
      {
        id: 'filename',
        name: 'filename',
        type: 'string',
        description: 'Original Source Document filename.',
        valueSource: 'source-filename',
      },
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
      originalFilename: 'bundled.pdf',
      sourceRepresentationId: representationId,
      sourceRepresentationRevisionId: representationId,
      parsingTaskId: 'fixture-task',
      contentSha256:
        '74d5f0bc42b7158d302e628a68451f4cd3a1aa9b7d84cabeb02ff8939f3a97cf',
      schemaRevisionId,
      extractionSchemaId: '66666666-6666-4666-8666-666666666666',
      schemaTree,
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
    readSource: async () => input.document ?? parsedDocument,
    resolveTarget: async () => ollamaTarget(),
  })(
    new Request('http://localhost/api/extractions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: input.extractionId,
        sourceRepresentationRevisionId: representationId,
        schemaRevisionId,
        strategy: input.strategy,
      }),
    }),
  )
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(201)
  return extractionAttemptSchema.parse(body)
}

function compactCatalogDocument(): ParsedDocument {
  const source = structuredClone(parsedDocument) as unknown as ParsedDocument
  const headings = [
    { text: '1. Introduction', level: 1, body: 'Introduction to collagen.' },
    { text: '1.1. Background', level: 2, body: 'Background subsection.' },
    { text: '2. Methods', level: 1, body: 'Methods for collagen analysis.' },
    { text: 'References', level: 1, body: 'Reference list.' },
  ]
  const blocks = headings.flatMap((heading, index) => [
    {
      block_id: `catalog-heading-${index}`,
      page_number: 1,
      parser: 'fixture',
      bbox: { x0: 1, y0: index * 12 + 1, x1: 100, y1: index * 12 + 5 },
      markdown_span: { start: index * 30, end: index * 30 + 5 },
      kind: 'heading',
      text: heading.text,
      level: heading.level,
    },
    {
      block_id: `catalog-body-${index}`,
      page_number: 1,
      parser: 'fixture',
      bbox: { x0: 1, y0: index * 12 + 6, x1: 100, y1: index * 12 + 10 },
      markdown_span: { start: index * 30 + 6, end: index * 30 + 12 },
      kind: 'paragraph',
      text: heading.body,
    },
  ]) as ParsedDocument['content_stream']
  source.content_stream = blocks
  source.pages[0].ordered_content = blocks.map((block) => block.block_id)
  source.evidence_index.anchors = blocks.map((block, index) => ({
    kind: 'text',
    anchor_id: `catalog-anchor-${index}`,
    occurrence_id: `catalog-occurrence-${index}`,
    content_sha256: source.document.content_sha256,
    preprocess_id: source.preprocessing.preprocess_id,
    block_id: block.block_id,
    page_number: 1,
    markdown_span: block.markdown_span!,
    bbox: block.bbox!,
  }))
  return source
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
      codes: attempt.diagnostics.catalog?.codes,
      starts: attempt.diagnostics.catalog?.boundaries.map(
        (boundary) => boundary.headingText,
      ),
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
      strategy: 'ARTICLE',
    })
    logAttempt('bundled-article', startedAt, attempt)
    expect(attempt).toMatchObject({
      strategy: 'ARTICLE',
      outcome: 'SUCCEEDED',
      complete: true,
      reviewable: true,
      resultPayload: { records: [{ filename: 'bundled.pdf' }] },
    })
  })
})

describe.skipIf(!CATALOG_SMOKE)('production-path compact Catalog provider smoke', () => {
  it('discovers, slices, extracts, grounds, and persists two records', { timeout: TIMEOUT_MS }, async () => {
    const startedAt = Date.now()
    const attempt = await runProviderSmoke({
      extractionId: '77777777-7777-4777-8777-777777777777',
      strategy: 'CATALOG',
      document: compactCatalogDocument(),
      schemaTree: {
        recordDescription: 'One top-level numbered article section.',
        schemaNodes: [
          {
            id: 'title',
            name: 'title',
            type: 'string',
            description: 'The exact section heading.',
          },
        ],
      },
    })
    logAttempt('compact-catalog', startedAt, attempt)
    expect(attempt).toMatchObject({
      strategy: 'CATALOG',
      outcome: 'SUCCEEDED',
      complete: true,
      reviewable: true,
      diagnostics: {
        catalog: {
          codes: [],
          boundaries: [
            expect.objectContaining({ headingText: '1. Introduction' }),
            expect.objectContaining({ headingText: '2. Methods' }),
          ],
        },
      },
    })
    expect(attempt.resultPayload?.records).toHaveLength(2)
  })
})

const retainedEnabled =
  (RETAINED_KIND === 'zhang' || RETAINED_KIND === 'beretning') &&
  Boolean(RETAINED_PATH)

describe.skipIf(!retainedEnabled)('production-path retained Catalog provider smoke', () => {
  it('returns the exact expected canonical records', { timeout: TIMEOUT_MS }, async () => {
    const retained = JSON.parse(
      await readFile(RETAINED_PATH!, 'utf8'),
    ) as ParsedDocument
    const zhang = RETAINED_KIND === 'zhang'
    if (zhang)
      retained.content_stream = retained.content_stream.map((block) => {
        if (block.kind !== 'heading') return block
        const outline = /^\s*(\d+(?:\.\d+)*)\.\s+/.exec(block.text)
        return outline
          ? { ...block, level: outline[1].split('.').length }
          : block
      })
    const expected = zhang
      ? [
          '1. Introduction',
          '2. Materials and Methods',
          '3. Results and Discussion',
          '4. Conclusions',
        ]
      : ['Grav 8', 'Grav 13', 'Grav 24', 'Grav 26', 'Grav 28', 'Grav 30', 'Grav 31']
    const startedAt = Date.now()
    const attempt = await runProviderSmoke({
      extractionId: zhang
        ? '88888888-8888-4888-8888-888888888888'
        : '99999999-9999-4999-8999-999999999999',
      strategy: 'CATALOG',
      document: retained,
      schemaTree: zhang
        ? {
            recordDescription: 'One top-level numbered research article section.',
            schemaNodes: [
              {
                id: 'sectionTitle',
                name: 'sectionTitle',
                type: 'string',
                description: 'The exact section heading.',
              },
            ],
          }
        : {
            recordDescription: 'One archaeological grave entry headed Grav N.',
            schemaNodes: [
              {
                id: 'graveNumber',
                name: 'graveNumber',
                type: 'integer',
                description: 'The grave number from the Grav N heading.',
              },
            ],
          },
    })
    logAttempt(`retained-${RETAINED_KIND}`, startedAt, attempt)
    expect(attempt).toMatchObject({
      outcome: 'SUCCEEDED',
      complete: true,
      reviewable: true,
      diagnostics: { catalog: { codes: [] } },
    })
    expect(
      attempt.diagnostics.catalog?.boundaries.map(
        (boundary) => boundary.headingText,
      ),
    ).toEqual(expected)
    const records = attempt.resultPayload?.records
    expect(records).toHaveLength(expected.length)
    if (!zhang && Array.isArray(records))
      expect(
        records.map((record) =>
          typeof record === 'object' && record !== null && !Array.isArray(record)
            ? record.graveNumber
            : null,
        ),
      ).toEqual([8, 13, 24, 26, 28, 30, 31])
  })
})
