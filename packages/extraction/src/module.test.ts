import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import parsedDocument from '../../../prototypes/studio/src/assets/parsed_document.v2.json' with { type: 'json' }
import { CATALOG_NOT_ATTEMPTED_LIMIT, CATALOG_RECORD_LIMIT } from './catalog.js'
import type {
  ExtractionJobInput,
  ExtractionInputReader,
  ExtractionModelSession,
  ExtractionModelRequest,
  ExtractionValueCheckpoint,
  TerminalExtraction,
} from './dependencies.js'
import { ExtractionError } from './errors.js'
import { createExtractionJobExecutor } from './module.js'
import { catalogDiscoveryChunks } from './source-context.js'
import { decodeParsedDocument } from './parsed-document.js'
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
  const inputs: ExtractionInputReader = {
    async readExtractionAttempt() {
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
  }
  const executeJob = createExtractionJobExecutor({
    inputs,
    models: {
      async open() {
        opened += 1
        return session
      },
    },
    now: () => 10,
  })
  const module = {
    executeJob,
    async runSingle(runInput: ExtractionJobInput) {
      const terminal = await executeJob(
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
function catalogDocument(labels: readonly string[], startKind: 'heading' | 'paragraph' | 'list' = 'heading') {
  const blocks: Record<string, unknown>[] = []
  const anchors: Record<string, unknown>[] = []
  const push = (blockId: string, kind: 'heading' | 'paragraph' | 'list', text: string) => {
    const span = { start: blocks.length * 10, end: blocks.length * 10 + 5 }
    const bbox = { x0: 36, y0: 36, x1: 100, y1: 54 }
    blocks.push({
      kind,
      block_id: blockId,
      page_number: 1,
      parser: 'bundled-fixture',
      bbox,
      markdown_span: span,
      ...(kind === 'list' ? { ordered: true, items: [text] } : { text }),
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
    push(`h${index}`, startKind, label)
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
  startKind?: 'heading' | 'paragraph' | 'list'
  labels?: readonly string[]
  starts?: readonly string[]
  discoveryResult?: Record<string, unknown>
  discoveryScript?: readonly Record<string, unknown>[]
  beforeDiscovery?: (signal: AbortSignal) => void
  schemaTree?: unknown
  script?: readonly ScriptedCall[]
} = {}) {
  const labels = options.labels ?? ['First', 'Second']
  const document = catalogDocument(labels, options.startKind)
  const store = new Map<string, ExtractionSnapshot>()
  let starts: readonly string[] =
    options.starts ?? labels.map((_, index) => `B${index * 2 + 1}`)
  const discoveryScript = [...options.discoveryScript ?? []]
  let script: ScriptedCall[] = [...(options.script ?? [])]
  const calls: { markdown: string; template: Record<string, unknown>; instruction?: string; outputSchema?: ExtractionModelRequest['outputSchema'] }[] = []
  const session: ExtractionModelSession = {
    attribution,
    model: {
      async extract(request) {
        calls.push({
          markdown: request.document.markdown,
          template: request.template as Record<string, unknown>,
          instruction: request.instruction,
          outputSchema: request.outputSchema,
        })
        if ('starts' in request.template) {
          options.beforeDiscovery?.(request.signal)
          return {
            result: options.discoveryResult ?? discoveryScript.shift() ?? { starts: options.starts ? [...starts] : starts.filter(
              (label) => request.document.markdown.includes(`[[block:${label}]]`),
            ) },
            metadata,
          }
        }
        const next = script.shift()
        if (!next) {
          const record = { title: 'X', year: 1900 }
          return { result: 'record' in request.template ? { record } : { records: [record] }, metadata }
        }
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
  const inputs: ExtractionInputReader = {
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
  }
  const executeJob = createExtractionJobExecutor({
    inputs,
    models: {
      async open() {
        return session
      },
    },
    now: () => 10,
  })
  const module = {
    executeJob,
    async runSingle(runInput: ExtractionJobInput) {
      const terminal = await executeJob(
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
  for (const startKind of ['paragraph', 'list'] as const) {
    it(`discovers catalogue entries parsed as ${startKind} blocks`, async () => {
      const harness = catalogHarness({ startKind, labels: ['29. Tangermünde', '30. Estedt'], starts: ['B1', 'B3'] })
      const { extraction } = await harness.module.runSingle(catalogInput())
      assert.equal(extraction.diagnostics.catalog?.records.length, 2)
      assert.ok(harness.calls[0].markdown.includes('[[block:B1]] 29. Tangermünde'))
      assert.ok(harness.calls[1].markdown.includes('29. Tangermünde body'))
      assert.ok(!harness.calls[1].markdown.includes('30. Estedt'))
      assert.ok(harness.calls[2].markdown.includes('30. Estedt body'))
    })
  }

  it('schedules one discovery call and one values call per canonical record slice', async () => {
    const harness = catalogHarness({
      script: [
        { result: { record: { title: 'Alpha', year: 1901 } } },
        { result: { record: { title: 'Beta', year: 1902 } } },
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
    assert.deepEqual(harness.calls[1].template, { record: { title: 'string', year: 'integer' } })
    assert.ok(harness.calls[0].markdown.includes('[[block:B1]] First'))
    assert.ok(harness.calls[0].markdown.includes('[[block:B3]] Second'))
    assert.ok(!harness.calls[0].markdown.includes('[[block:B5]]'))
    assert.ok(harness.calls[1].markdown.includes('First body'))
    assert.ok(!harness.calls[1].markdown.includes('Second body'))
    assert.ok(harness.calls[2].markdown.includes('Second body'))
    assert.deepEqual(extraction.diagnostics.groundingBatches.map(batch => batch.candidateCount), [2, 2])
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
        { result: { record: { title: 'Alpha', year: 1901 } } },
        { error: new Error('record exploded') },
        { result: { record: { title: 'Gamma', year: 1903 } } },
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

  it('rejects multiple objects for one catalogue entry without dropping its successful sibling', async () => {
    const harness = catalogHarness({ script: [
      { result: { record: [{ title: 'Parent' }, { title: 'Subentry' }] } },
      { result: { record: { title: 'Second', year: 1902 } } },
    ] })
    const { extraction } = await harness.module.runSingle(catalogInput())
    assert.equal(extraction.complete, false)
    assert.deepEqual(extraction.result, { records: [{ title: 'Second', year: 1902 }] })
    assert.equal(extraction.diagnostics.catalog?.records[0].failureCode, 'invalid_model_output')
  })

  it('requires selectable unique block IDs before record extraction', async () => {
    const cases: ReadonlyArray<
      readonly [readonly string[], 'unknown_start' | 'duplicate_start']
    > = [
      [['B999'], 'unknown_start'],
      [['h1'], 'unknown_start'],
      [['B1', 'B1'], 'duplicate_start'],
      [['B1', '[[block:B1]]'], 'duplicate_start'],
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
      assert.equal(harness.calls.length, 2)
    }
  })

  it('corrects the captured title-instead-of-ID failure and counts both attempts', async () => {
    const harness = catalogHarness({ labels: ['215. Oberheldrungen', '216. Langeneichstädt'], discoveryScript: [
      { starts: ['215. Oberheldrungen'], end: '[[block:B3]]' },
      { starts: ['B1'], end: 'B3' },
    ] })
    const { extraction } = await harness.module.runSingle(catalogInput())
    const calls = harness.calls.filter(call => 'starts' in call.template)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].markdown, calls[1].markdown)
    assert.match(calls[1].instruction!, /215\. Oberheldrungen/)
    assert.match(calls[1].instruction!, /not entry titles/)
    assert.equal(extraction.diagnostics.catalog?.stages.find(stage => stage.stage === 'discovery')?.calls, 2)
    assert.equal(extraction.diagnostics.catalog?.stages.find(stage => stage.stage === 'discovery')?.inputTokens, 20)
    assert.equal(extraction.diagnostics.modelCalls, 3)
    assert.equal((extraction.result?.records as unknown[]).length, 1)
    assert.equal(calls[0].outputSchema?.safeParse({ starts: ['B1'], end: null }).success, true)
    assert.equal(calls[0].outputSchema?.safeParse({ starts: ['215. Oberheldrungen'], end: null }).success, false)
    assert.equal(calls[0].outputSchema?.safeParse({ starts: ['B1'], end: 'B999' }).success, false)
  })

  it('normalizes whitespace and block wrappers without a correction call', async () => {
    const harness = catalogHarness({ discoveryResult: { starts: [' [[block:B1]] '], end: ' [[block:B3]] ' } })
    const { extraction } = await harness.module.runSingle(catalogInput())
    assert.equal(harness.calls.filter(call => 'starts' in call.template).length, 1)
    assert.equal((extraction.result?.records as unknown[]).length, 1)
  })

  it('retries only the failed later chunk without committing its invalid boundaries', async () => {
    const labels = ['First', 'Second'].map(label => `${label} ${'content '.repeat(1800)}`)
    const harness = catalogHarness({ labels, discoveryScript: [
      { starts: ['B1'], end: null }, { starts: [], end: null },
      { starts: ['B3'], end: '[[block:B999]]' },
      { starts: ['B3'], end: null }, { starts: [], end: null },
    ] })
    const { extraction } = await harness.module.runSingle(catalogInput())
    const calls = harness.calls.filter(call => 'starts' in call.template)
    assert.equal(calls.length, 5)
    assert.equal(calls[2].markdown, calls[3].markdown)
    assert.equal(calls[2].outputSchema?.safeParse({ starts: ['B1'], end: null }).success, false)
    assert.equal((extraction.result?.records as unknown[]).length, 2)
  })

  it('fails after one correction for a title, foreign ID, or invalid end', async () => {
    for (const discoveryResult of [
      { starts: ['215. Oberheldrungen'], end: null },
      { starts: ['[[block:B999]]'], end: null },
      { starts: ['B1'], end: '[[block:B999]]' },
      { starts: ['B1'], end: 'B1' },
      { starts: ['B1'], end: null, explanation: 'extra key' },
      { starts: null, end: null },
    ]) {
      const harness = catalogHarness({ discoveryResult })
      await assert.rejects(harness.module.runSingle(catalogInput()), /Catalog discovery chunk 1 failed after one correction/)
      assert.equal(harness.calls.length, 2)
    }
  })

  it('does not retry transport failures or cancellation during discovery', async () => {
    const unavailable = new ExtractionError('model_unavailable', 'offline')
    const harness = catalogHarness({ beforeDiscovery: () => { throw unavailable } })
    await assert.rejects(harness.module.runSingle(catalogInput()), /offline/)
    assert.equal(harness.calls.length, 1)

    const controller = new AbortController()
    const cancelled = catalogHarness({
      beforeDiscovery: () => controller.abort(),
      discoveryResult: { starts: ['215. Oberheldrungen'], end: null },
    })
    await assert.rejects(cancelled.module.executeJob(catalogInput(), null, async () => {}, controller.signal), { name: 'AbortError' })
    assert.equal(cancelled.calls.length, 1)
  })

  it('caps Catalog boundaries at the record limit with ordered skip diagnostics', async () => {
    const labels = Array.from({ length: CATALOG_RECORD_LIMIT + 2 }, (_, i) => `Entry ${i}`)
    const harness = catalogHarness({ labels })
    const { extraction } = await harness.module.runSingle(catalogInput())
    assert.equal(extraction.outcome, 'SUCCEEDED')
    assert.equal(extraction.complete, false)
    assert.equal(harness.calls.filter(call => !('starts' in call.template)).length, CATALOG_RECORD_LIMIT)
    const records = extraction.diagnostics.catalog?.records ?? []
    assert.equal(records.length, labels.length)
    for (const skipped of records.slice(CATALOG_RECORD_LIMIT)) {
      assert.equal(skipped.outcome, 'not_attempted')
      assert.equal(skipped.failureCode, CATALOG_NOT_ATTEMPTED_LIMIT)
      assert.equal(skipped.calls, 0)
    }
  })

  it('covers a 420-entry catalogue in one run', async () => {
    const harness = catalogHarness({
      labels: Array.from({ length: 420 }, (_, index) => `Entry ${index + 1}`),
      schemaTree: { recordDescription: 'One catalogue entry.', schemaNodes: [
        { id: 'filename', name: 'filename', type: 'string', valueSource: 'source-filename' },
      ] },
    })
    const { extraction } = await harness.module.runSingle(catalogInput())
    assert.equal(extraction.complete, true)
    assert.equal((extraction.result?.records as unknown[]).length, 420)
  })

  it('discovers every block once in bounded chunks and sums discovery diagnostics', async () => {
    const labels = ['First', 'Middle', 'Last'].map(label => `${label} ${'content '.repeat(1800)}`)
    const chunks = catalogDiscoveryChunks(decodeParsedDocument(catalogDocument(labels, 'paragraph')))
    assert.ok(chunks.length > 1)
    assert.deepEqual(chunks.flatMap(chunk => [...chunk.startBlockIdByLabel.keys()]),
      ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'])
    for (const chunk of chunks) assert.ok(chunk.text.length < 19_000)
    assert.ok(chunks[0].text.includes('Following context (not selectable):\n## Page 1\nFirst'))
    assert.ok(!chunks[0].startBlockIdByLabel.has('B2'))
    assert.ok(!chunks.at(-1)!.text.includes('Following context (not selectable)'))
    const harness = catalogHarness({ labels, startKind: 'paragraph' })
    const { extraction } = await harness.module.runSingle(catalogInput())
    assert.equal((extraction.result?.records as unknown[]).length, 3)
    assert.equal(extraction.diagnostics.catalog?.stages.find(stage => stage.stage === 'discovery')?.calls, chunks.length)
    assert.equal(extraction.diagnostics.catalog?.stages.find(stage => stage.stage === 'discovery')?.inputTokens, chunks.length * metadata.inputTokens)
    const discoveryCalls = harness.calls.filter(call => 'starts' in call.template)
    assert.ok(discoveryCalls[1].markdown.includes('Previous catalog record start (context only, never select again):\nFirst'))
  })

  it('keeps normal physical pages together and their block labels separate', () => {
    const source = catalogDocument(['First', 'Second'], 'paragraph')
    source.page_count = source.document.page_count = 2
    source.content_stream.slice(2).forEach(block => { block.page_number = 2 })
    source.evidence_index.anchors.slice(2).forEach(anchor => {
      (anchor.producer_observations as { page_number: number }[])[0].page_number = 2
    })
    source.pages = [1, 2].map(page => ({ ...source.pages[0], page_number: page,
      ordered_content: source.content_stream.filter(block => block.page_number === page).map(block => block.block_id),
    }))
    const chunks = catalogDiscoveryChunks(decodeParsedDocument(source))
    assert.deepEqual(chunks.map(chunk => [...chunk.startBlockIdByLabel.keys()]), [['B1', 'B2'], ['B3', 'B4']])
  })

  it('carries an ended section into later excerpts until a new matching record starts', async () => {
    const labels = ['First', 'Index', 'Second'].map(label => `${label} ${'content '.repeat(1800)}`)
    const harness = catalogHarness({ labels, discoveryScript: [
      { starts: ['B1'] }, { starts: [] }, { starts: [], end: 'B3' },
      { starts: [] }, { starts: ['B5'] }, { starts: [] },
    ] })
    await harness.module.runSingle(catalogInput())
    const calls = harness.calls.filter(call => 'starts' in call.template)
    assert.ok(calls[3].markdown.includes('Previous catalog section ended before this block (context only, not selectable):\n## Page 1\nIndex'))
    assert.ok(!calls[5].markdown.includes('Previous catalog section ended'))
  })

  it('excludes a discovered trailing index from the final record values', async () => {
    const harness = catalogHarness({ startKind: 'paragraph', discoveryResult: { starts: ['B1'], end: 'B3' } })
    await harness.module.runSingle(catalogInput())
    assert.ok(harness.calls[1].markdown.includes('First body'))
    assert.ok(!harness.calls[1].markdown.includes('Second'))
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
      script: [{ result: { record: { archive: 'Copenhagen' } } }],
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
        { result: { record: { title: 'Alpha', year: 1901 } } },
        { error: new Error('record exploded') },
        { result: { record: { title: 'Gamma', year: 1903 } } },
      ],
    })
    const parent = (await harness.module.runSingle(catalogInput())).extraction

    harness.calls.length = 0
    harness.setScript([{ result: { record: { title: 'Beta', year: 1902 } } }])
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
        { result: { record: { title: 'Alpha', year: 1901 } } },
        { result: { record: { title: 'Beta', year: 1902 } } },
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
