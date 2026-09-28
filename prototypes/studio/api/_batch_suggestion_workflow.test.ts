import type { StepConfig } from '@dbos-inc/dbos-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SchemaModelInput } from './_schema_suggestion.js'
import { ApiError } from './_http.js'
import { ModelKeyRequiredError } from './_model_keys.js'
import {
  registerBatchSuggestionWorkflow,
  SUGGEST_SCHEMA_BATCH,
  suggestSchemaBatchWorkflow,
  type SuggestionAttemptInput,
  type SuggestionProposal,
  type SuggestionWorkflowPorts,
} from './_batch_suggestion_workflow.js'

const registerWorkflow = vi.hoisted(() => vi.fn())
vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOS: { registerWorkflow } }))

const SUGGESTION = 'suggestion-1'
const PROJECT = 'project-1'
const OWNER = 'owner-account'
const A = { sourceDocumentId: 'source-a', sourceRepresentationRevisionId: 'revision-a' }
const B = { sourceDocumentId: 'source-b', sourceRepresentationRevisionId: 'revision-b' }
const C = { sourceDocumentId: 'source-c', sourceRepresentationRevisionId: 'revision-c' }
const MARKDOWN: Record<string, string> = { 'revision-a': '# Source A', 'revision-b': '# Source B', 'revision-c': '# Source C' }

const sourceTemplate = { _description: 'One article.', title: 'string', year: 'integer' }
const commonTemplate = { _description: 'One article.', title: 'string' }
const emptyTemplate = { _description: 'One article.' }
const SOURCES_FAILED = { code: 'source_suggestion_failed', message: 'Fields could not be suggested for every selected Source Document.' }

type Generated = Awaited<ReturnType<SuggestionWorkflowPorts['generate']>>
const generated = (template: Record<string, unknown>): Generated => ({ template, raw: JSON.stringify(template), pages: null })

type Scenario = {
  /** The answer to the model call for this markdown (a source's) or for the merge ('merge'). */
  generate?: (markdown: string, input: SchemaModelInput) => Promise<Generated>
  /** attemptState's answer for its n-th call (0-based). */
  attemptState?: (call: number) => 'current' | 'stopped'
  owner?: string | null
  readMarkdown?: (revisionId: string) => string | null
  publishes?: 'published' | 'stopped'
  cancel?: AbortController
  members?: SuggestionAttemptInput['members']
  /** DBOS's checkpoints: a step whose name is here returns its recorded output without running (recovery). */
  checkpoints?: Map<string, unknown>
  /** Throws when this step is reached, as a crash before it would. */
  crashAt?: string
}

function harness(scenario: Scenario = {}) {
  const input: SuggestionAttemptInput = { batchSchemaSuggestionId: SUGGESTION, attempt: 2, projectContextId: PROJECT, members: scenario.members ?? [A, B] }
  const steps: string[] = []
  const configs = new Map<string, StepConfig | undefined>()
  const writes: Array<{ kind: 'publish'; result: SuggestionProposal } | { kind: 'fail'; failure: { code: string; message: string } }> = []
  const calls: Array<{ caller: { researcherAccountId: string }; input: SchemaModelInput }> = []
  const cancel = scenario.cancel ?? new AbortController()
  let stateCalls = 0
  const ports: SuggestionWorkflowPorts = {
    steps: {
      async step<T>(name: string, run: () => Promise<T>, config?: StepConfig): Promise<T> {
        configs.set(name, config)
        if (scenario.checkpoints?.has(name)) return scenario.checkpoints.get(name) as T
        if (name === scenario.crashAt) throw new Error(`crashed before ${name}`)
        steps.push(name)
        const output = await run()
        scenario.checkpoints?.set(name, output)
        return output
      },
      cancelSignal: () => cancel.signal,
    },
    store: {
      async attemptState(id, attempt) {
        expect([id, attempt]).toEqual([SUGGESTION, 2])
        return scenario.attemptState?.(stateCalls++) ?? 'current'
      },
      async projectContextOwner(id) {
        expect(id).toBe(PROJECT)
        return scenario.owner === undefined ? OWNER : scenario.owner
      },
      async readMarkdown(revisionId) {
        return scenario.readMarkdown ? scenario.readMarkdown(revisionId) : (MARKDOWN[revisionId] ?? null)
      },
      async publish(id, attempt, result) {
        expect([id, attempt]).toEqual([SUGGESTION, 2])
        writes.push({ kind: 'publish', result })
        return scenario.publishes ?? 'published'
      },
      async fail(id, attempt, failure) {
        expect([id, attempt]).toEqual([SUGGESTION, 2])
        writes.push({ kind: 'fail', failure })
        return scenario.publishes ?? 'published'
      },
    },
    generate: async (caller, modelInput) => {
      calls.push({ caller, input: modelInput })
      const markdown = modelInput.document.markdown ?? ''
      const key = markdown.startsWith('SOURCE DOCUMENT ') ? 'merge' : markdown
      if (scenario.generate) return scenario.generate(key, modelInput)
      return generated(key === 'merge' ? commonTemplate : sourceTemplate)
    },
  }
  return { input, ports, steps, configs, writes, calls, cancel, run: () => suggestSchemaBatchWorkflow(input, ports) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('suggestSchemaBatch', () => {
  it('generates each pinned source in its own named step, in sorted order, then merges and publishes once', async () => {
    const h = harness()
    await h.run()
    expect(h.steps).toEqual(['suggestSource:source-a', 'suggestSource:source-b', 'merge', 'publish'])
    expect(h.calls.map((call) => call.input.document.markdown?.split('\n')[0])).toEqual([
      '# Source A', '# Source B', 'SOURCE DOCUMENT source-a SUGGESTION:',
    ])
    expect(h.writes).toHaveLength(1)
    const [write] = h.writes
    if (write?.kind !== 'publish' || write.result.phase !== 'READY') throw new Error('expected a READY publication')
    expect(write.result.proposal.schemaNodes.map((node) => node.name)).toEqual(['title'])
    expect(write.result.draft).toEqual(write.result.proposal)
    expect(write.result.coverage).toEqual([{ nodeId: write.result.proposal.schemaNodes[0]!.id, present: 2, total: 2 }])
  })

  it('the first failed source ends the attempt: no later source runs, no merge, and its failure is published', async () => {
    const cases = [
      { error: () => new ModelKeyRequiredError(), failure: { code: 'model_key_required', message: new ModelKeyRequiredError().message } },
      { error: () => new ApiError(502, 'invalid_model_output', 'The model returned an invalid Schema Suggestion.'), failure: SOURCES_FAILED },
      { error: () => new ApiError(502, 'model_operation_failed', 'The model operation failed.'), failure: SOURCES_FAILED },
      { error: () => new Error('provider body with secrets'), failure: SOURCES_FAILED },
    ]
    for (const { error, failure } of cases) {
      const h = harness({
        members: [A, B, C],
        generate: async (markdown) => {
          if (markdown === '# Source B') throw error()
          return generated(sourceTemplate)
        },
      })
      await h.run()
      expect(h.steps).toEqual(['suggestSource:source-a', 'suggestSource:source-b', 'publishFailure'])
      expect(h.calls.map((call) => call.input.document.markdown)).toEqual(['# Source A', '# Source B'])
      expect(h.writes).toEqual([{ kind: 'fail', failure }])
    }
  })

  it('a missing key at the first source fails the attempt with model_key_required without waiting on the others', async () => {
    const h = harness({ members: [A, B, C], generate: async () => { throw new ModelKeyRequiredError() } })
    await h.run()
    expect(h.calls).toHaveLength(1)
    expect(h.steps).toEqual(['suggestSource:source-a', 'publishFailure'])
    expect(h.writes).toEqual([{ kind: 'fail', failure: { code: 'model_key_required', message: new ModelKeyRequiredError().message } }])
  })

  it('recovery of the same attempt reuses the sources it already checkpointed', async () => {
    const checkpoints = new Map<string, unknown>()
    const crashed = harness({ members: [A, B, C], checkpoints, crashAt: 'suggestSource:source-c' })
    await expect(crashed.run()).rejects.toThrow('crashed before suggestSource:source-c')
    expect(crashed.calls).toHaveLength(2)

    const recovered = harness({ members: [A, B, C], checkpoints })
    await recovered.run()
    expect(recovered.steps).toEqual(['suggestSource:source-c', 'merge', 'publish'])
    expect(recovered.calls.map((call) => call.input.document.markdown?.split('\n')[0])).toEqual([
      '# Source C', 'SOURCE DOCUMENT source-a SUGGESTION:',
    ])
    expect(recovered.writes.map((write) => write.kind)).toEqual(['publish'])
  })

  it('stops without publishing when its attempt was interrupted, superseded or its scope deleted', async () => {
    const stopped = harness({ attemptState: (call) => (call === 0 ? 'current' : 'stopped') })
    await stopped.run()
    expect(stopped.steps).toEqual(['suggestSource:source-a', 'suggestSource:source-b'])
    expect(stopped.calls).toHaveLength(1)
    expect(stopped.writes).toEqual([])

    const ownerGone = harness({ owner: null })
    await ownerGone.run()
    expect(ownerGone.steps).toEqual(['suggestSource:source-a'])
    expect(ownerGone.calls).toEqual([])
    expect(ownerGone.writes).toEqual([])

    const revisionGone = harness({ readMarkdown: (revisionId) => (revisionId === 'revision-b' ? null : MARKDOWN[revisionId]!) })
    await revisionGone.run()
    expect(revisionGone.steps).toEqual(['suggestSource:source-a', 'suggestSource:source-b'])
    expect(revisionGone.calls).toHaveLength(1)
    expect(revisionGone.writes).toEqual([])

    const stoppedBeforeMerge = harness({ attemptState: (call) => (call < 2 ? 'current' : 'stopped') })
    await stoppedBeforeMerge.run()
    expect(stoppedBeforeMerge.steps).toEqual(['suggestSource:source-a', 'suggestSource:source-b', 'merge'])
    expect(stoppedBeforeMerge.calls).toHaveLength(2)
    expect(stoppedBeforeMerge.writes).toEqual([])
  })

  it('a heterogeneous merge publishes HETEROGENEOUS without a proposal', async () => {
    const h = harness({ generate: async (markdown) => generated(markdown === 'merge' ? emptyTemplate : sourceTemplate) })
    await h.run()
    expect(h.steps).toEqual(['suggestSource:source-a', 'suggestSource:source-b', 'merge', 'publish'])
    expect(h.writes).toEqual([{ kind: 'publish', result: { phase: 'HETEROGENEOUS' } }])
  })

  it('a failed merge publishes the merge\'s failure without provider details', async () => {
    const h = harness({
      generate: async (markdown) => {
        if (markdown === 'merge') throw Object.assign(new Error('Bearer sk-test-merge'), { cause: 'provider body' })
        return generated(sourceTemplate)
      },
    })
    await h.run()
    expect(h.steps).toEqual(['suggestSource:source-a', 'suggestSource:source-b', 'merge', 'publish'])
    expect(h.writes).toEqual([{ kind: 'fail', failure: { code: 'unexpected_failure', message: 'The operation failed unexpectedly.' } }])
  })

  it('each model call gets the step\'s cancel signal and a ten-minute limit', async () => {
    const timeouts: AbortController[] = []
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController()
      timeouts.push(controller)
      return controller.signal
    })
    const h = harness()
    await h.run()
    expect(h.calls).toHaveLength(3)
    expect(timeout.mock.calls).toEqual([[600_000], [600_000], [600_000]])
    const signals = h.calls.map((call) => call.input.signal!)
    expect(signals.every((signal) => !signal.aborted)).toBe(true)
    timeouts[0]!.abort()
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false, false])
    h.cancel.abort()
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  })

  it('every call resolves the Project Context owner\'s account', async () => {
    const h = harness()
    await h.run()
    expect(h.calls.map((call) => call.caller)).toEqual([
      { researcherAccountId: OWNER }, { researcherAccountId: OWNER }, { researcherAccountId: OWNER },
    ])
  })

  it('every step that reads or writes the store retries a transient PostgreSQL error, and nothing else', async () => {
    const h = harness()
    await h.run()
    const failed = harness({ members: [A], generate: async () => { throw new Error('model down') } })
    await failed.run()
    const configs = new Map([...h.configs, ...failed.configs])
    expect([...configs.keys()]).toEqual(['suggestSource:source-a', 'suggestSource:source-b', 'merge', 'publish', 'publishFailure'])
    const dropped = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })
    const wrapped = Object.assign(new Error('Query failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
    const refused = Object.assign(new Error('connection refused'), { sqlState: '08006' })
    const terminated = new Error('Connection terminated unexpectedly')
    const missingPackage = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    const constraint = Object.assign(new Error('duplicate key'), { code: '23505' })
    for (const [name, config] of configs) {
      expect(config?.retriesAllowed, name).toBe(true)
      expect(config?.maxAttempts, name).toBeLessThanOrEqual(5)
      for (const transient of [dropped, wrapped, refused, terminated]) expect(config?.shouldRetry?.(transient), name).toBe(true)
      for (const lasting of [missingPackage, constraint, new Error('bug')]) expect(config?.shouldRetry?.(lasting), name).toBe(false)
    }
  })

  it('a failure publication that finds the attempt stopped writes nothing and does not throw', async () => {
    const h = harness({ publishes: 'stopped', generate: async () => { throw new ModelKeyRequiredError() } })
    await expect(h.run()).resolves.toBeUndefined()
    expect(h.steps).toEqual(['suggestSource:source-a', 'publishFailure'])
    expect(h.writes.map((write) => write.kind)).toEqual(['fail'])
  })

  it('registers under the name suggestSchemaBatch and builds its ports per run', async () => {
    const h = harness()
    const ports = vi.fn(() => h.ports)
    registerBatchSuggestionWorkflow(ports)
    expect(registerWorkflow).toHaveBeenCalledTimes(1)
    const [fn, options] = registerWorkflow.mock.calls[0]!
    expect(options).toEqual({ name: SUGGEST_SCHEMA_BATCH })
    expect(SUGGEST_SCHEMA_BATCH).toBe('suggestSchemaBatch')
    expect(ports).not.toHaveBeenCalled()
    await fn(h.input)
    expect(ports).toHaveBeenCalledTimes(1)
    expect(h.writes.map((write) => write.kind)).toEqual(['publish'])
  })
})
