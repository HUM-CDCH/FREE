import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { it } from 'node:test'
import type {
  ClaimedExtractionJob,
  InternalExtractionJobStore,
  TerminalExtraction,
} from './dependencies.js'
import { ExtractionJobWorker } from './job-worker.js'

it('checkpoints values before terminal promotion', async () => {
  const extractionId = randomUUID()
  const sourceDocumentId = randomUUID()
  const sourceRepresentationRevisionId = randomUUID()
  const schemaRevisionId = randomUUID()
  const lease = { owner: randomUUID(), version: 1, expiresAt: new Date(Date.now() + 60_000) }
  const job: ClaimedExtractionJob = {
    input: {
      kind: 'fresh', extractionId, sourceRepresentationRevisionId,
      schemaRevisionId, strategy: 'ARTICLE',
    },
    checkpoint: null,
    lease,
  }
  const events: string[] = []
  let failurePhase: string | null = null
  let available = true
  let finish!: () => void
  const finished = new Promise<void>((resolve) => { finish = resolve })
  const store: InternalExtractionJobStore = {
    async claim() {
      if (!available) return null
      available = false
      return job
    },
    async renew() { return 'owned' },
    async checkpoint() { events.push('checkpoint'); return true },
    async complete() { events.push('complete'); throw new Error('promotion failed') },
    async fail(_id, _lease, failure) {
      events.push('fail')
      failurePhase = failure.phase
      finish()
      return true
    },
  }
  const terminal: TerminalExtraction = {
    extractionId, sourceDocumentId, sourceRepresentationRevisionId,
    schemaRevisionId, strategy: 'ARTICLE', outcome: 'SUCCEEDED', complete: true,
    modelAttribution: { provider: 'test', modelId: 'test' },
    diagnostics: {
      phase: 'persisting', durationMs: 1, modelCalls: 1, finishReason: 'stop',
      inputTokens: 1, outputTokens: 1, ungroundedPaths: [], groundingIssues: [],
      groundingBatches: [], catalog: null, retry: null,
    },
    failure: null, result: { records: [] }, evidence: [], reviewable: true,
    retryOfId: null, batchExtractionId: null,
  }
  const worker = new ExtractionJobWorker(store,
    async (_input, _checkpoint, saveCheckpoint) => {
      await saveCheckpoint({
        complete: true,
        modelAttribution: terminal.modelAttribution!,
        diagnostics: { ...terminal.diagnostics, phase: 'grounding' },
        result: terminal.result!,
      })
      return terminal
    },
  )
  const stop = new AbortController()
  const running = worker.run(stop.signal)
  worker.wake()
  await finished
  stop.abort()
  await running
  assert.deepEqual(events, ['checkpoint', 'complete', 'fail'])
  assert.equal(failurePhase, 'grounding')
})

it('stays in extracting when the checkpoint write fails', async () => {
  const extractionId = randomUUID()
  const job: ClaimedExtractionJob = {
    input: {
      kind: 'fresh', extractionId,
      sourceRepresentationRevisionId: randomUUID(),
      schemaRevisionId: randomUUID(), strategy: 'ARTICLE',
    },
    checkpoint: null,
    lease: { owner: randomUUID(), version: 1, expiresAt: new Date(Date.now() + 60_000) },
  }
  let available = true
  let failurePhase: string | null = null
  let finish!: () => void
  const finished = new Promise<void>((resolve) => { finish = resolve })
  const store: InternalExtractionJobStore = {
    async claim() {
      if (!available) return null
      available = false
      return job
    },
    async renew() { return 'owned' },
    async checkpoint() { return false },
    async complete() { assert.fail('work without a checkpoint must not be promoted') },
    async fail(_id, _lease, failure) {
      failurePhase = failure.phase
      finish()
      return true
    },
  }
  const worker = new ExtractionJobWorker(store,
    async (_input, _checkpoint, saveCheckpoint) => {
      await saveCheckpoint({
        complete: true,
        modelAttribution: { provider: 'test', modelId: 'test' },
        diagnostics: {
          phase: 'grounding', durationMs: 1, modelCalls: 1,
          finishReason: 'stop', inputTokens: 1, outputTokens: 1,
          ungroundedPaths: [], groundingIssues: [], groundingBatches: [],
          catalog: null, retry: null,
        },
        result: { records: [] },
      })
      assert.fail('a rejected checkpoint must stop execution')
    },
  )
  const stop = new AbortController()
  const running = worker.run(stop.signal)
  worker.wake()
  await finished
  stop.abort()
  await running
  assert.equal(failurePhase, 'extracting')
})

it('derives reclaimed cancellation phase from its stored checkpoint', async () => {
  const extractionId = randomUUID()
  const sourceRepresentationRevisionId = randomUUID()
  const schemaRevisionId = randomUUID()
  const terminal: TerminalExtraction = {
    extractionId,
    sourceDocumentId: randomUUID(),
    sourceRepresentationRevisionId,
    schemaRevisionId,
    strategy: 'ARTICLE',
    outcome: 'SUCCEEDED',
    complete: true,
    modelAttribution: { provider: 'test', modelId: 'test' },
    diagnostics: {
      phase: 'persisting', durationMs: 1, modelCalls: 1, finishReason: 'stop',
      inputTokens: 1, outputTokens: 1, ungroundedPaths: [], groundingIssues: [],
      groundingBatches: [], catalog: null, retry: null,
    },
    failure: null, result: { records: [] }, evidence: [], reviewable: true,
    retryOfId: null, batchExtractionId: null,
  }
  const job = {
    input: {
      kind: 'fresh' as const,
      extractionId,
      sourceRepresentationRevisionId,
      schemaRevisionId,
      strategy: 'ARTICLE' as const,
    },
    checkpoint: {
      complete: true,
      modelAttribution: terminal.modelAttribution!,
      diagnostics: { ...terminal.diagnostics, phase: 'grounding' as const },
      result: terminal.result!,
    },
    lease: { owner: randomUUID(), version: 1, expiresAt: new Date(Date.now() + 60_000) },
  }
  let available = true
  let failureCode: string | null = null
  let failurePhase: string | null = null
  let finish!: () => void
  const finished = new Promise<void>((resolve) => { finish = resolve })
  const store: InternalExtractionJobStore = {
    async claim() {
      if (!available) return null
      available = false
      return job
    },
    async renew() { return 'cancelled' },
    async checkpoint() { return true },
    async complete() { assert.fail('cancelled work must not be promoted') },
    async fail(_id, _lease, failure) {
      failureCode = failure.code
      failurePhase = failure.phase
      finish()
      return true
    },
  }
  const worker = new ExtractionJobWorker(store, async () => terminal)
  const stop = new AbortController()
  const running = worker.run(stop.signal)
  worker.wake()
  await finished
  stop.abort()
  await running
  assert.equal(failureCode, 'cancelled')
  assert.equal(failurePhase, 'grounding')
})

it('fails instead of stranding a job when terminal promotion loses its lease', async () => {
  const extractionId = randomUUID()
  const sourceRepresentationRevisionId = randomUUID()
  const schemaRevisionId = randomUUID()
  const job: ClaimedExtractionJob = {
    input: {
      kind: 'fresh', extractionId,
      sourceRepresentationRevisionId,
      schemaRevisionId, strategy: 'ARTICLE',
    },
    checkpoint: null,
    lease: { owner: randomUUID(), version: 1, expiresAt: new Date(Date.now() + 60_000) },
  }
  let available = true
  let failureCode: string | null = null
  let failurePhase: string | null = null
  let finish!: () => void
  const finished = new Promise<void>((resolve) => { finish = resolve })
  const store: InternalExtractionJobStore = {
    async claim() {
      if (!available) return null
      available = false
      return job
    },
    async renew() { return 'owned' },
    async checkpoint() { return true },
    async complete() { return false },
    async fail(_id, _lease, failure) {
      failureCode = failure.code
      failurePhase = failure.phase
      finish()
      return true
    },
  }
  const terminal: TerminalExtraction = {
    extractionId,
    sourceDocumentId: randomUUID(),
    sourceRepresentationRevisionId,
    schemaRevisionId,
    strategy: 'ARTICLE', outcome: 'SUCCEEDED', complete: true,
    modelAttribution: { provider: 'test', modelId: 'test' },
    diagnostics: {
      phase: 'grounding', durationMs: 1, modelCalls: 1, finishReason: 'stop',
      inputTokens: 1, outputTokens: 1, ungroundedPaths: [], groundingIssues: [],
      groundingBatches: [], catalog: null, retry: null,
    },
    failure: null, result: { records: [] }, evidence: [], reviewable: true,
    retryOfId: null, batchExtractionId: null,
  }
  const worker = new ExtractionJobWorker(store, async () => terminal)
  const stop = new AbortController()
  const running = worker.run(stop.signal)
  worker.wake()
  await finished
  stop.abort()
  await running
  assert.equal(failureCode, 'cancelled')
  assert.equal(failurePhase, 'extracting')
})
