import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type {
  ProjectStore,
  StoredExtractionAttempt,
  TerminalExtractionInput,
} from '../../../packages/db/src/project-store.js'
import {
  extractionAttemptSchema,
  type ExtractionAttempt,
} from '../shared/extraction.contract.js'
import type {
  ParsedContentBlock,
  ParsedDocument,
  TextEvidenceAnchor,
} from '../shared/parsedDocument.js'
import { decodeParsedDocument } from '../shared/parsedDocument.js'
import { createExtractionsApi } from './extractions.js'
import { readModelConfig } from './_model_config.js'
import { resolveCapabilityRoute } from './_provider.js'
import type { ProviderKind } from '../shared/modelConfig.contract.js'
import { isRecord } from '../shared/template.js'

const ENABLED = process.env.FREE_LIVE_TASK6B === '1'
const TIMEOUT_MS = 12 * 60 * 1_000
const sourceDocumentId = '22222222-2222-4222-8222-222222222222'
const sourceRepresentationRevisionId = '33333333-3333-4333-8333-333333333333'
const schemaRevisionId = '44444444-4444-4444-8444-444444444444'
const retainedMarkdown = readFileSync(
  new URL('../src/assets/document.md', import.meta.url),
  'utf8',
)
const retainedHeadingBoundaries = [
  { label: 'Grav 8', blockId: 'beretning-grav-8', start: 0, end: 2 },
  { label: 'Grav 13', blockId: 'beretning-grav-13', start: 2, end: 4 },
  { label: 'Grav 24', blockId: 'beretning-grav-24', start: 4, end: 6 },
  { label: 'Grav 26', blockId: 'beretning-grav-26', start: 6, end: 8 },
  { label: 'Grav 28', blockId: 'beretning-grav-28', start: 8, end: 10 },
  { label: 'Grav 30', blockId: 'beretning-grav-30', start: 10, end: 12 },
  { label: 'Grav 31', blockId: 'beretning-grav-31', start: 12, end: 14 },
] as const
const extractionIds = {
  'ollama:ARTICLE': '11111111-1111-4111-8111-111111111111',
  'ollama:CATALOG': '11111111-1111-4111-8111-111111111112',
  'codex-cli:ARTICLE': '11111111-1111-4111-8111-111111111113',
  'codex-cli:CATALOG': '11111111-1111-4111-8111-111111111114',
} as const

type Strategy = 'ARTICLE' | 'CATALOG'

function retainedDocument(): ParsedDocument {
  const contentSha256 = createHash('sha256')
    .update(retainedMarkdown, 'utf8')
    .digest('hex')
  const lines = retainedMarkdown.split(/\r?\n/)
  const blocks: ParsedContentBlock[] = []
  const newlineWidth = retainedMarkdown.includes('\r\n') ? 2 : 1
  const lineStarts: number[] = []
  let characterOffset = 0
  for (const line of lines) {
    lineStarts.push(characterOffset)
    characterOffset += line.length + newlineWidth
  }
  const appendBlock = ({
    blockId,
    kind,
    text,
    startLine,
    endLine,
    level,
  }: {
    blockId: string
    kind: 'heading' | 'paragraph'
    text: string
    startLine: number
    endLine: number
    level?: number
  }) => {
    const markdownSpan = {
      start: Buffer.byteLength(retainedMarkdown.slice(0, lineStarts[startLine]), 'utf8'),
      end: Buffer.byteLength(
        retainedMarkdown.slice(0, lineStarts[endLine] + lines[endLine].length),
        'utf8',
      ),
    }
    blocks.push({
      block_id: blockId,
      kind,
      ...(level === undefined ? {} : { level }),
      text,
      page_number: 1,
      parser: 'retained-beretning',
      bbox: { x0: 10, y0: 4 + blocks.length * 4, x1: 602, y1: 7 + blocks.length * 4 },
      markdown_span: markdownSpan,
    } as ParsedContentBlock)
  }
  const headings = lines.flatMap((line, lineIndex) => {
    const match = /^## (Grav \d+)$/.exec(line)
    return match ? [{ lineIndex, label: match[1] }] : []
  })
  for (const [headingIndex, heading] of headings.entries()) {
    const nextHeadingLine = headings[headingIndex + 1]?.lineIndex ?? lines.length
    appendBlock({
      blockId: `beretning-${heading.label.toLowerCase().replace(' ', '-')}`,
      kind: 'heading',
      text: heading.label,
      startLine: heading.lineIndex,
      endLine: heading.lineIndex,
      level: 2,
    })
    const bodyLines = lines
      .slice(heading.lineIndex + 1, nextHeadingLine)
      .flatMap((line, offset) => line.trim() ? [heading.lineIndex + 1 + offset] : [])
    if (bodyLines.length === 0) continue
    appendBlock({
      blockId: `beretning-${heading.label.toLowerCase().replace(' ', '-')}-content`,
      kind: 'paragraph',
      text: bodyLines.map((lineIndex) => lines[lineIndex]).join('\n'),
      startLine: bodyLines[0],
      endLine: bodyLines.at(-1)!,
    })
  }
  const pageSpan = {
    start: 0,
    end: Buffer.byteLength(retainedMarkdown, 'utf8'),
  }
  const document = {
    schema_version: 'parsed_document.v2' as const,
    document: {
      document_id: 'document_beretning_ellekilde_8_13',
      content_sha256: contentSha256,
      source: {
        kind: 'upload' as const,
        original_filename: 'Beretning_Ellekilde_8_13.pdf',
        media_type: 'application/pdf' as const,
        byte_size: null,
      },
      created_at: '2026-08-12T00:00:00Z',
      page_count: 1,
      language_hints: ['da'],
      is_encrypted: false,
      input_profile: {
        file_kind: 'pdf' as const,
        detected_mime: 'application/pdf',
        pdf_version: null,
        has_text_layer: true,
        has_images: true,
      },
    },
    preprocessing: {
      preprocess_id: 'retained-beretning',
      profile: 'production_default',
      service_version: 'retained-harness',
      started_at: null,
      finished_at: null,
      status: 'completed' as const,
      warnings: [],
    },
    page_count: 1,
    page_mapping_verified: true as const,
    artifacts: {
      source_ref: 'source.pdf' as const,
      parsed_json_ref: 'parsed_document.json' as const,
      markdown_ref: 'artifacts/document.llm.md' as const,
    },
    parser_runs: [],
    arbitration: null,
    diagnostics: [],
    content_stream: blocks,
    pages: [{
      page_number: 1,
      width_pt: 612,
      height_pt: 792,
      rotation: 0,
      ordered_content: blocks.map(({ block_id }) => block_id),
      unplaced_content: [],
      markdown_span: pageSpan,
    }],
    tables: [],
    evidence_index: {
      anchors: blocks.map((block, index) => ({
        kind: 'text' as const,
        anchor_id: `beretning-anchor-${String(index + 1).padStart(3, '0')}`,
        content_sha256: contentSha256,
        preprocess_id: 'retained-beretning',
        block_id: block.block_id,
        markdown_span: block.markdown_span!,
        producer_observations: [{
          occurrence_id: `beretning-occurrence-${String(index + 1).padStart(3, '0')}`,
          page_number: 1,
          producer_ref: `#/texts/${index}`,
          bbox: block.bbox!,
        }],
      } satisfies TextEvidenceAnchor)),
    },
  }
  return decodeParsedDocument(document)
}

function schemaTree(strategy: Strategy) {
  return {
    recordDescription:
      strategy === 'CATALOG'
        ? 'One catalog record. Return the exact Grav heading at the start of this source slice.'
        : 'One article. Return the exact first Grav heading in the source.',
    schemaNodes: [
      {
        id: 'title',
        name: 'title',
        type: 'string',
        description:
          strategy === 'CATALOG'
            ? 'The exact Grav heading at the start of this source slice.'
            : 'The exact first Grav heading in the source.',
      },
    ],
  }
}

function firstArticleRecord(attempt: ExtractionAttempt): Record<string, unknown> {
  const recordsValue: unknown = attempt.resultPayload?.records
  if (!Array.isArray(recordsValue) || recordsValue.length === 0 || !isRecord(recordsValue[0]))
    throw new Error('Article live gate returned no visible record.')
  return recordsValue[0]
}

function catalogStage(
  attempt: ExtractionAttempt,
  stage: 'document-values' | 'discovery' | 'record-values' | 'grounding',
) {
  const stages = attempt.diagnostics.catalog?.stages ?? []
  const match = stages.find((candidate) => candidate.stage === stage)
  if (!match) throw new Error(`Catalog live gate omitted ${stage} diagnostics.`)
  return match
}

function scheduledCallCount(attempt: ExtractionAttempt): number {
  if (attempt.strategy === 'ARTICLE')
    return (
      (attempt.diagnostics.values === null ? 0 : 1) +
      (attempt.diagnostics.grounding?.batches.length ?? 0)
    )
  return (
    attempt.diagnostics.catalog?.stages.reduce(
      (total, stage) => total + stage.calls,
      0,
    ) ?? 0
  )
}

function storeFor(schema: ReturnType<typeof schemaTree>): ProjectStore {
  let persisted: TerminalExtractionInput | null = null
  return {
    getExtractionAttempt: async () => null,
    getExtractionInputs: async () => ({
      sourceDocumentId,
      projectContextId: '55555555-5555-4555-8555-555555555555',
      sourceRepresentationId: sourceRepresentationRevisionId,
      sourceRepresentationRevisionId,
      schemaRevisionId,
      extractionSchemaId: '66666666-6666-4666-8666-666666666666',
      schemaTree: schema,
      descriptor: { artifactReference: 'a'.repeat(64), artifactSha256: 'a'.repeat(64) },
    }),
    persistExtractionAttempt: async (terminal: TerminalExtractionInput) => {
      persisted = terminal
      const attempt: StoredExtractionAttempt = {
        ...terminal,
        sourceRepresentationRevisionNumber: 1,
        extractionSchemaId: '66666666-6666-4666-8666-666666666666',
        schemaRevisionNumber: 1,
        schemaTree: schema,
        createdAt: new Date(),
        reviewedAt: null,
        reviewDecisions: [],
      }
      return { status: 'created' as const, attempt }
    },
    getExtractionAttemptForOwner: async () => persisted,
    reviewExtractionAttempt: async () => null,
  } as unknown as ProjectStore
}

function summary(provider: ProviderKind, modelId: string, strategy: Strategy, attempt: ExtractionAttempt) {
  const diagnostics = attempt.diagnostics
  console.info(JSON.stringify({
    provider,
    model: modelId,
    strategy,
    retries: diagnostics.modelCalls - scheduledCallCount(attempt),
    outcome: attempt.outcome,
    complete: attempt.complete,
    reviewable: attempt.reviewable,
    calls: diagnostics.modelCalls,
    finishReason: diagnostics.finishReason,
    inputTokens: diagnostics.inputTokens,
    outputTokens: diagnostics.outputTokens,
    durationMs: diagnostics.durationMs,
    values: diagnostics.values,
    stages: diagnostics.catalog?.stages ?? null,
    records: diagnostics.catalog?.records.map(({ ordinal, boundary, ...call }) => ({ ordinal, boundary, ...call })) ?? null,
    grounding: diagnostics.grounding,
  }))
}

async function run(provider: ProviderKind, modelId: string, strategy: Strategy): Promise<ExtractionAttempt> {
  const config = await readModelConfig()
  const connection = config.connections.find(({ provider: kind }) => kind === provider)
  if (!connection) throw new Error(`Configured ${provider} connection is missing.`)
  const injectedConfig = {
    ...config,
    routes: {
      ...config.routes,
      extraction: { connectionId: connection.id, modelId },
    },
  }
  const schema = schemaTree(strategy)
  const handler = createExtractionsApi({
    store: storeFor(schema),
    readSource: async () => retainedDocument(),
    resolveTarget: async () => resolveCapabilityRoute('extraction', {}, { config: injectedConfig }),
  })
  const response = await handler(new Request('http://studio/api/extractions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: extractionIds[`${provider}:${strategy}` as keyof typeof extractionIds],
      sourceRepresentationRevisionId,
      schemaRevisionId,
      strategy,
    }),
  }))
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(201)
  const attempt = extractionAttemptSchema.parse(body)
  summary(provider, modelId, strategy, attempt)
  return attempt
}

describe.skipIf(!ENABLED)('Task 6b configured-provider live gate', () => {
  it('runs Article and Catalog once through every configured provider', { timeout: TIMEOUT_MS }, async () => {
    const config = await readModelConfig()
    const ollama = config.connections.find(({ provider }) => provider === 'ollama')
    const codex = config.connections.find(({ provider }) => provider === 'codex-cli')
    if (!ollama || !codex) throw new Error('Both Ollama and Codex CLI connections must be configured.')
    const ollamaModel = config.routes.extraction?.connectionId === ollama.id
      ? config.routes.extraction.modelId
      : process.env.FREE_LIVE_OLLAMA_MODEL ?? 'gemma4:12b'
    const codexModel = process.env.FREE_LIVE_CODEX_MODEL ?? 'gpt-5.6-luna'
    const cases = [
      ['ollama', ollamaModel, 'ARTICLE'],
      ['ollama', ollamaModel, 'CATALOG'],
      ['codex-cli', codexModel, 'ARTICLE'],
      ['codex-cli', codexModel, 'CATALOG'],
    ] as const
    const attempts = []
    for (const [provider, modelId, strategy] of cases)
      attempts.push(await run(provider, modelId, strategy))
    for (const attempt of attempts) {
      expect(attempt.outcome).toBe('SUCCEEDED')
      expect(attempt.complete).toBe(true)
      expect(attempt.reviewable).toBe(true)
      expect(attempt.diagnostics.modelCalls).toBeGreaterThan(0)
      expect(attempt.diagnostics.modelCalls - scheduledCallCount(attempt)).toBe(0)
      expect(attempt.diagnostics.grounding?.ungroundedPaths).toEqual([])
      expect(attempt.diagnostics.grounding?.issueCodes).toEqual([])
    }
    const articleAttempts = attempts.filter(({ strategy }) => strategy === 'ARTICLE')
    for (const attempt of articleAttempts) {
      const groundingBatches = attempt.diagnostics.grounding?.batches ?? []
      expect(attempt.diagnostics.catalog).toBeNull()
      expect(attempt.diagnostics.retry ?? null).toBeNull()
      expect(attempt.diagnostics.values?.outcome).toBe('succeeded')
      expect(groundingBatches.length).toBeGreaterThan(0)
      expect(attempt.diagnostics.modelCalls).toBe(1 + groundingBatches.length)
      expect(firstArticleRecord(attempt)).toEqual({ title: 'Grav 8' })
    }
    const catalogAttempts = attempts.filter(({ strategy }) => strategy === 'CATALOG')
    for (const attempt of catalogAttempts) {
      const records = attempt.diagnostics.catalog?.records ?? []
      expect(records).toHaveLength(retainedHeadingBoundaries.length)
      const documentStage = catalogStage(attempt, 'document-values')
      const discoveryStage = catalogStage(attempt, 'discovery')
      const recordStage = catalogStage(attempt, 'record-values')
      const groundingStage = catalogStage(attempt, 'grounding')
      expect(attempt.diagnostics.retry ?? null).toBeNull()
      expect(documentStage).toMatchObject({ outcome: 'not_attempted', calls: 0 })
      expect(discoveryStage).toMatchObject({ outcome: 'succeeded', calls: 1 })
      expect(recordStage).toMatchObject({ outcome: 'succeeded', calls: records.length })
      expect(groundingStage).toMatchObject({ outcome: 'succeeded', calls: records.length })
      expect(attempt.diagnostics.modelCalls).toBe(
        discoveryStage.calls + recordStage.calls + groundingStage.calls,
      )
      expect(records.map(({ ordinal, boundary }) => ({
        ordinal,
        boundary: {
          startBlockId: boundary.startBlockId,
          startContentIndex: boundary.startContentIndex,
          endContentIndex: boundary.endContentIndex,
          headingText: boundary.headingText,
          headingLevel: boundary.headingLevel,
        },
      }))).toEqual(retainedHeadingBoundaries.map(({ label, blockId, start, end }, ordinal) => ({
        ordinal,
        boundary: {
          startBlockId: blockId,
          startContentIndex: start,
          endContentIndex: end,
          headingText: label,
          headingLevel: 2,
        },
      })))
      expect(attempt.resultPayload).toEqual({
        records: retainedHeadingBoundaries.map(({ label }) => ({ title: label })),
      })
      expect(records.every(({ outcome, calls }) => outcome === 'succeeded' && calls === 1)).toBe(true)
    }
  })
})
