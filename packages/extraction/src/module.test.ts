import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import parsedDocument from '../../../prototypes/studio/src/assets/parsed_document.v2.json' with { type: 'json' }
import { CATALOG_NOT_ATTEMPTED_LIMIT, CATALOG_RECORD_LIMIT } from './catalog.js'
import type {
  ExtractionModelSession,
  ExtractionPersistence,
  ExtractionValueCheckpoint,
  TerminalExtraction,
} from './dependencies.js'
import { ExtractionError } from './errors.js'
import { createExtractionModule } from './module.js'
import type { ExtractionSnapshot } from './types.js'

const metadata = {
  finishReason: 'stop',
  inputTokens: 10,
  outputTokens: 5,
  durationMs: 2,
} as const
const attribution = { provider: 'test', modelId: 'pinned' } as const
const schemaTree = {
  recordDescription: 'Article records.',
  schemaNodes: [
    { id: 'title', name: 'title', type: 'string' },
    { id: 'year', name: 'year', type: 'integer' },
  ],
}

function snapshot(terminal: TerminalExtraction): ExtractionSnapshot {
  return {
    ...terminal,
    extractionSchemaId: randomUUID(),
    sourceRepresentationRevisionNumber: 1,
    schemaRevisionNumber: 1,
    createdAt: new Date('2026-08-20T00:00:00.000Z'),
    reviewedAt: null,
    reviewDecisions: [],
  }
}

function harness(
  records: readonly Record<string, unknown>[],
  selections: (claimLabels: readonly string[], anchorLabels: readonly string[]) =>
    readonly { claimLabel: string; anchorLabel: string | null }[] =
    (claimLabels, anchorLabels) =>
      claimLabels.map((claimLabel, index) => ({
        claimLabel,
        anchorLabel: anchorLabels[index] ?? anchorLabels[0] ?? null,
      })),
) {
  let opened = 0
  let valueCalls = 0
  let persisted: TerminalExtraction | null = null
  const session: ExtractionModelSession = {
    attribution,
    model: {
      async extract() {
        valueCalls += 1
        return { result: { records }, metadata }
      },
    },
    groundingModel: {
      async ground(request) {
        return {
          selections: selections(
            Object.keys(request.claims),
            Object.keys(request.anchors),
          ),
          metadata,
        }
      },
    },
  }
  const persistence = {
    async readExtraction() {
      return null
    },
    async loadExtractionInputs(
      sourceRepresentationRevisionId: string,
      schemaRevisionId: string,
    ) {
      return {
        sourceDocumentId: randomUUID(),
        projectContextId: randomUUID(),
        sourceRepresentationRevisionId,
        schemaRevisionId,
        schemaTree,
        parsedDocument,
      }
    },
  } as unknown as ExtractionPersistence
  const execution = createExtractionModule({
    persistence,
    models: {
      async open() {
        opened += 1
        return session
      },
    },
    now: () => 10,
  })
  const module = {
    ...execution,
    async runSingle(runInput: Parameters<typeof execution.executeJob>[0]) {
      const terminal = await execution.executeJob(
        runInput,
        null,
        async () => {},
        new AbortController().signal,
      )
      persisted = terminal
      return { disposition: 'created' as const, extraction: snapshot(terminal) }
    },
  }
  return {
    module,
    opened: () => opened,
    valueCalls: () => valueCalls,
    persisted: () => persisted,
  }
}

function input() {
  return {
    kind: 'fresh' as const,
    extractionId: randomUUID(),
    sourceRepresentationRevisionId: randomUUID(),
    schemaRevisionId: randomUUID(),
    strategy: 'ARTICLE' as const,
  }
}

describe('ExtractionModule Article contract', () => {
  it('resumes grounding from a value checkpoint without repeating extraction', async () => {
    const article = harness([{ title: 'Alpha', year: 1901 }])
    const run = input()
    let checkpoint: ExtractionValueCheckpoint | null = null
    await article.module.executeJob(
      run,
      null,
      async (value) => { checkpoint = value },
      new AbortController().signal,
    )
    assert.equal(article.valueCalls(), 1)
    assert.ok(checkpoint)

    await article.module.executeJob(
      run,
      checkpoint,
      async () => assert.fail('resumed values must not checkpoint again'),
      new AbortController().signal,
    )
    assert.equal(article.valueCalls(), 1)
  })

  it('retains valid zero- and multi-record Article results', async () => {
    const empty = harness([])
    assert.deepEqual((await empty.module.runSingle(input())).extraction.result, {
      records: [],
    })

    const multiple = harness([
      { title: 'Alpha', year: 1901 },
      { title: 'Beta', year: 1902 },
    ])
    const result = await multiple.module.runSingle(input())
    assert.deepEqual(result.extraction.result, {
      records: [
        { title: 'Alpha', year: 1901 },
        { title: 'Beta', year: 1902 },
      ],
    })
    assert.equal(multiple.opened(), 1)
    assert.equal(result.extraction.diagnostics.groundingBatches.length, 2)
  })

  it('keeps a partially grounded result reviewable and incomplete', async () => {
    const partial = harness(
      [{ title: 'Alpha', year: 1901 }],
      (claimLabels, anchorLabels) => [
        { claimLabel: claimLabels[0]!, anchorLabel: anchorLabels[0] ?? null },
      ],
    )
    const result = await partial.module.runSingle(input())
    assert.equal(result.extraction.outcome, 'SUCCEEDED')
    assert.equal(result.extraction.reviewable, true)
    assert.equal(result.extraction.complete, false)
    assert.equal(result.extraction.diagnostics.ungroundedPaths.length, 1)
    assert.equal(partial.persisted()?.modelAttribution, attribution)
  })
})

/** A one-page parsed_document.v2 where each label is a level-2 heading with one body paragraph. */
function catalogDocument(labels: readonly string[]) {
  const blocks: Record<string, unknown>[] = []
  const anchors: Record<string, unknown>[] = []
  const push = (blockId: string, kind: 'heading' | 'paragraph', text: string) => {
    const span = { start: blocks.length * 10, end: blocks.length * 10 + 5 }
    const bbox = { x0: 36, y0: 36, x1: 100, y1: 54 }
    blocks.push({
      kind,
      block_id: blockId,
      page_number: 1,
      parser: 'bundled-fixture',
      bbox,
      markdown_span: span,
      text,
      ...(kind === 'heading' ? { level: 2 } : {}),
    })
    anchors.push({
      kind: 'text',
      anchor_id: `anchor-${blockId}`,
      content_sha256: parsedDocument.document.content_sha256,
      preprocess_id: parsedDocument.preprocessing.preprocess_id,
      block_id: blockId,
      markdown_span: span,
      producer_observations: [{
        occurrence_id: `occurrence-${blockId}`,
        page_number: 1,
        producer_ref: '#/texts/1',
        bbox,
      }],
    })
  }
  labels.forEach((label, index) => {
    push(`h${index}`, 'heading', label)
    push(`p${index}`, 'paragraph', `${label} body`)
  })
  return {
    ...parsedDocument,
    document: { ...parsedDocument.document, page_count: 1 },
    page_count: 1,
    pages: [{
      ...parsedDocument.pages[0],
      page_number: 1,
      ordered_content: blocks.map((block) => block.block_id),
      markdown_span: null,
    }],
    content_stream: blocks,
    evidence_index: { anchors },
  }
}

type ScriptedCall =
  | { result: Record<string, unknown> }
  | { error: Error }

function catalogHarness(options: {
  labels?: readonly string[]
  starts?: readonly string[]
  discoveryResult?: Record<string, unknown>
  schemaTree?: unknown
  script?: readonly ScriptedCall[]
} = {}) {
  const labels = options.labels ?? ['First', 'Second']
  const document = catalogDocument(labels)
  const store = new Map<string, ExtractionSnapshot>()
  let starts: readonly string[] =
    options.starts ?? labels.map((_, index) => `H${index + 1}`)
  let script: ScriptedCall[] = [...(options.script ?? [])]
  const calls: { markdown: string; template: Record<string, unknown> }[] = []
  const session: ExtractionModelSession = {
    attribution,
    model: {
      async extract(request) {
        calls.push({
          markdown: request.document.markdown,
          template: request.template as Record<string, unknown>,
        })
        if ('starts' in request.template)
          return {
            result: options.discoveryResult ?? { starts: [...starts] },
            metadata,
          }
        const next = script.shift()
        if (!next) return { result: { records: [{ title: 'X', year: 1900 }] }, metadata }
        if ('error' in next) throw next.error
        return { result: next.result, metadata }
      },
    },
    groundingModel: {
      async ground(request) {
        const anchorLabels = Object.keys(request.anchors)
        return {
          selections: Object.keys(request.claims).map((claimLabel, index) => ({
            claimLabel,
            anchorLabel: anchorLabels[index] ?? anchorLabels[0] ?? null,
          })),
          metadata,
        }
      },
    },
  }
  const persistence = {
    async readExtraction(extractionId: string) {
      return store.get(extractionId) ?? null
    },
    async readExtractionAttempt(extractionId: string) {
      const extraction = store.get(extractionId)
      return extraction
        ? { ...extraction, executionStatus: 'COMPLETED' as const }
        : null
    },
    async loadExtractionInputs(
      sourceRepresentationRevisionId: string,
      schemaRevisionId: string,
    ) {
      return {
        sourceDocumentId: randomUUID(),
        projectContextId: randomUUID(),
        sourceRepresentationRevisionId,
        schemaRevisionId,
        schemaTree: options.schemaTree ?? schemaTree,
        parsedDocument: document,
      }
    },
  } as unknown as ExtractionPersistence
  const execution = createExtractionModule({
    persistence,
    models: {
      async open() {
        return session
      },
    },
    now: () => 10,
  })
  const module = {
    ...execution,
    async runSingle(runInput: Parameters<typeof execution.executeJob>[0]) {
      const terminal = await execution.executeJob(
        runInput,
        null,
        async () => {},
        new AbortController().signal,
      )
      const stored = snapshot(terminal)
      store.set(terminal.extractionId, stored)
      return { disposition: 'created' as const, extraction: stored }
    },
  }
  return {
    module,
    calls,
    setScript: (next: readonly ScriptedCall[]) => { script = [...next] },
    setStarts: (next: readonly string[]) => { starts = next },
  }
}

function catalogInput() {
  return { ...input(), strategy: 'CATALOG' as const }
}

function retryInput(retryOfId: string, selection: Partial<{
  retryDocument: boolean
  rediscover: boolean
  retryRecordStartBlockIds: readonly string[]
}> = {}) {
  return {
    kind: 'retry' as const,
    extractionId: randomUUID(),
    retryOfId,
    retryDocument: false,
    rediscover: false,
    retryRecordStartBlockIds: [] as readonly string[],
    ...selection,
  }
}

describe('ExtractionModule Catalog contract', () => {
  it('schedules one discovery call and one values call per canonical record slice', async () => {
    const harness = catalogHarness({
      script: [
        { result: { records: [{ title: 'Alpha', year: 1901 }] } },
        { result: { records: [{ title: 'Beta', year: 1902 }] } },
      ],
    })
    const { extraction } = await harness.module.runSingle(catalogInput())
    assert.equal(extraction.strategy, 'CATALOG')
    assert.equal(extraction.outcome, 'SUCCEEDED')
    assert.equal(extraction.complete, true)
    assert.deepEqual(extraction.result, {
      records: [
        { title: 'Alpha', year: 1901 },
        { title: 'Beta', year: 1902 },
      ],
    })
    // One discovery call plus one bounded call per canonical slice.
    assert.equal(harness.calls.length, 3)
    assert.ok('starts' in harness.calls[0].template)
    assert.ok(harness.calls[0].markdown.includes('[[heading:H1]] First'))
    assert.ok(harness.calls[0].markdown.includes('[[heading:H2]] Second'))
    assert.ok(!harness.calls[0].markdown.includes('[[heading:H3]]'))
    assert.ok(harness.calls[1].markdown.includes('First body'))
    assert.ok(!harness.calls[1].markdown.includes('Second body'))
    assert.ok(harness.calls[2].markdown.includes('Second body'))
    const catalog = extraction.diagnostics.catalog
    assert.ok(catalog)
    assert.deepEqual(
      catalog.stages.map((stage) => [stage.stage, stage.outcome]),
      [
        ['document-values', 'not_attempted'],
        ['discovery', 'succeeded'],
        ['record-values', 'succeeded'],
        ['grounding', 'succeeded'],
      ],
    )
    assert.deepEqual(
      catalog.records.map((record) => [record.boundary.startBlockId, record.outcome]),
      [['h0', 'succeeded'], ['h1', 'succeeded']],
    )
  })

  it('keeps successful records around an individual record failure', async () => {
    const harness = catalogHarness({
      labels: ['First', 'Second', 'Third'],
      script: [
        { result: { records: [{ title: 'Alpha', year: 1901 }] } },
        { error: new Error('record exploded') },
        { result: { records: [{ title: 'Gamma', year: 1903 }] } },
      ],
    })
    const { extraction } = await harness.module.runSingle(catalogInput())
    assert.equal(extraction.outcome, 'SUCCEEDED')
    assert.equal(extraction.complete, false)
    assert.deepEqual(extraction.result, {
      records: [
        { title: 'Alpha', year: 1901 },
        { title: 'Gamma', year: 1903 },
      ],
    })
    assert.deepEqual(
      extraction.diagnostics.catalog?.records.map((record) => record.outcome),
      ['succeeded', 'failed', 'succeeded'],
    )
  })

  it('requires exact unique short heading IDs before record extraction', async () => {
    const cases: ReadonlyArray<
      readonly [readonly string[], 'unknown_start' | 'duplicate_start']
    > = [
      [['H999'], 'unknown_start'],
      [['h1'], 'unknown_start'],
      [[' H1'], 'unknown_start'],
      [['H1 '], 'unknown_start'],
      [['H1', 'H1'], 'duplicate_start'],
    ]
    for (const [starts, failureCode] of cases) {
      const harness = catalogHarness({ starts })
      await assert.rejects(
        harness.module.runSingle(catalogInput()),
        (error: unknown) =>
          error instanceof ExtractionError &&
          error.code === 'catalog_discovery_failed' &&
          error.cause instanceof Error &&
          'code' in error.cause &&
          error.cause.code === failureCode,
      )
      assert.equal(harness.calls.length, 1)
    }
  })

  it('caps Catalog boundaries at the record limit with ordered skip diagnostics', async () => {
    const labels = Array.from({ length: CATALOG_RECORD_LIMIT + 2 }, (_, i) => `Entry ${i}`)
    const harness = catalogHarness({ labels })
    const { extraction } = await harness.module.runSingle(catalogInput())
    assert.equal(extraction.outcome, 'SUCCEEDED')
    assert.equal(extraction.complete, false)
    // One discovery call and exactly the first 100 record calls.
    assert.equal(harness.calls.length, 1 + CATALOG_RECORD_LIMIT)
    const records = extraction.diagnostics.catalog?.records ?? []
    assert.equal(records.length, labels.length)
    for (const skipped of records.slice(CATALOG_RECORD_LIMIT)) {
      assert.equal(skipped.outcome, 'not_attempted')
      assert.equal(skipped.failureCode, CATALOG_NOT_ATTEMPTED_LIMIT)
      assert.equal(skipped.calls, 0)
    }
  })

  it('extracts document-scoped fields once and overlays package values without model calls', async () => {
    const harness = catalogHarness({
      schemaTree: {
        recordDescription: 'Catalog records.',
        schemaNodes: [
          { id: 'archive', name: 'archive', type: 'string', valueSource: 'document' },
          { id: 'file', name: 'file', type: 'string', valueSource: 'source-filename' },
        ],
      },
      script: [{ result: { records: [{ archive: 'Copenhagen' }] } }],
    })
    const { extraction } = await harness.module.runSingle(catalogInput())
    assert.equal(extraction.outcome, 'SUCCEEDED')
    // One document-values call and one discovery call; record slices need no call.
    assert.equal(harness.calls.length, 2)
    assert.deepEqual(extraction.result, {
      records: [
        { archive: 'Copenhagen', file: 'bundled.pdf' },
        { archive: 'Copenhagen', file: 'bundled.pdf' },
      ],
    })
    const catalog = extraction.diagnostics.catalog
    assert.equal(
      catalog?.stages.find((stage) => stage.stage === 'document-values')?.outcome,
      'succeeded',
    )
    assert.ok(catalog?.records.every((record) => record.calls === 0))
  })

  it('retries one failed Catalog record and reuses its successful siblings', async () => {
    const harness = catalogHarness({
      labels: ['First', 'Second', 'Third'],
      script: [
        { result: { records: [{ title: 'Alpha', year: 1901 }] } },
        { error: new Error('record exploded') },
        { result: { records: [{ title: 'Gamma', year: 1903 }] } },
      ],
    })
    const parent = (await harness.module.runSingle(catalogInput())).extraction

    harness.calls.length = 0
    harness.setScript([{ result: { records: [{ title: 'Beta', year: 1902 }] } }])
    const child = (
      await harness.module.runSingle(
        retryInput(parent.extractionId, { retryRecordStartBlockIds: ['h1'] }),
      )
    ).extraction
    assert.equal(child.strategy, 'CATALOG')
    assert.equal(child.retryOfId, parent.extractionId)
    assert.equal(child.outcome, 'SUCCEEDED')
    assert.equal(child.complete, true)
    assert.deepEqual(child.result, {
      records: [
        { title: 'Alpha', year: 1901 },
        { title: 'Beta', year: 1902 },
        { title: 'Gamma', year: 1903 },
      ],
    })
    // Only the selected record was executed; siblings were reused with no calls.
    assert.equal(harness.calls.length, 1)
    assert.ok(harness.calls[0].markdown.includes('Second body'))
    assert.deepEqual(
      child.diagnostics.catalog?.records.map((record) => [record.provenance, record.calls]),
      [['reused', 0], ['executed', 1], ['reused', 0]],
    )
    assert.deepEqual(child.diagnostics.retry, {
      retryOfId: parent.extractionId,
      retryDocument: false,
      rediscover: false,
      retryRecordStartBlockIds: ['h1'],
    })
    assert.equal(child.reviewedAt, null)
    assert.equal(child.reviewDecisions.length, 0)
  })

  it('performs a grounding-only retry without values or discovery calls', async () => {
    const harness = catalogHarness({
      script: [
        { result: { records: [{ title: 'Alpha', year: 1901 }] } },
        { result: { records: [{ title: 'Beta', year: 1902 }] } },
      ],
    })
    const parent = (await harness.module.runSingle(catalogInput())).extraction

    harness.calls.length = 0
    const child = (
      await harness.module.runSingle(retryInput(parent.extractionId))
    ).extraction
    assert.equal(harness.calls.length, 0)
    assert.equal(child.outcome, 'SUCCEEDED')
    assert.deepEqual(child.result, parent.result)
    assert.ok(
      child.diagnostics.catalog?.records.every(
        (record) => record.provenance === 'reused',
      ),
    )
  })

  it('rejects Article targeted retries', async () => {
    const harness = catalogHarness()
    const parent = (await harness.module.runSingle(input())).extraction
    await assert.rejects(
      harness.module.runSingle(retryInput(parent.extractionId)),
      (error: unknown) =>
        error instanceof ExtractionError && error.code === 'invalid_retry',
    )
  })

})
