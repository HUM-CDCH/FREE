import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { Error as DBOSErrors, type StepConfig } from '@dbos-inc/dbos-sdk'
import parsedDocument from '../../../prototypes/studio/src/assets/parsed_document.v2.json' with { type: 'json' }
import { ExtractionError } from './errors.js'
import { extractionMethod, keiMethodOptions, settingsSlot } from './extraction-method.js'
import { keiExpArtifact, keiExpEvidence } from './kei-exp-fixture.js'
import { SUBMIT_TO_KEI_RETRY, type KeiExtractInput, type KeiHandoff, type KeiPoll, type KeiSubmission } from './kei-handoff.js'
import type { ExtractionStrategy } from './types.js'
import { ARTIFACT_READ_RETRY } from './workflow-steps.js'
import {
  extractionAttributes, extractionFailureOf, runExtractionWorkflow, type AdmittedExtraction, type SettledExtraction,
} from './workflows.js'

const RUN = 'run-1'
const schema = { recordDescription: 'Article records.', schemaNodes: [{ id: 'title', name: 'title', type: 'string' }] }

/** Admitted on service defaults unless `overrides` pins settings: the strategy's own slot, recorded as null. */
function admittedExtraction(overrides: Partial<AdmittedExtraction> = {}): AdmittedExtraction {
  const slot = settingsSlot(overrides.strategy ?? 'ARTICLE', overrides.catalogRecipe ?? null)
  return {
    extractionId: randomUUID(), owner: 'researcher@example.test', projectContextId: randomUUID(),
    sourceDocumentId: randomUUID(), sourceRepresentationRevisionId: randomUUID(), schemaRevisionId: randomUUID(),
    extractionSchemaId: randomUUID(), strategy: 'ARTICLE', catalogRecipe: null, requestedModels: null,
    requestedSettings: { [slot]: null }, batchExtractionId: null, preprocessId: `kei-exp:${RUN}:g1`, schemaTree: schema,
    ...overrides,
  }
}
const strategyOf = (strategy: ExtractionStrategy) => (strategy === 'CATALOG' ? 'catalog' : 'article')
const artifactFor = (admitted: AdmittedExtraction, overrides: Parameters<typeof keiExpArtifact>[0] = {}) =>
  keiExpArtifact({
    run_id: RUN, generation: 'g1', strategy: strategyOf(admitted.strategy), model: 'fields-model', schema,
    options: { model: null, ...keiMethodOptions(extractionMethod(admitted.strategy, admitted.catalogRecipe,
      admitted.requestedModels, admitted.requestedSettings)), models: admitted.requestedModels },
    records: [{ title: 'Alpha' }], evidence: [keiExpEvidence()], ...overrides,
  })
const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function extractOk(admitted: AdmittedExtraction, bytes: Uint8Array, overrides: Record<string, unknown> = {}) {
  return {
    ok: true, run_id: RUN, extraction_id: admitted.extractionId, generation: 'g1', artifact_sha256: sha256(bytes),
    model: 'fields-model', models: { fields: 'fields-model', reasoning: 'fields-model' }, ...overrides,
  }
}

type Scenario = {
  admitted?: AdmittedExtraction | null
  /** What each pollKei step answers, in order; the last one repeats. Defaults to kei's success over the artifact. */
  polls?: KeiPoll[]
  artifact?: unknown
  /** The bytes readArtifact serves; defaults to the artifact's JSON. */
  bytes?: Uint8Array
  /** The ExtractOk fields to override in the default success. */
  ok?: Record<string, unknown>
  pinnedDocument?: unknown
  /** The row's outcome before the workflow runs (a cancel or a replay that won). */
  settled?: SettledExtraction
  settle?: (settled: SettledExtraction) => Promise<'settled' | 'already-settled' | 'missing'>
  /** Throws for a step before it runs, as DBOS does for a step of a cancelled workflow. */
  beforeStep?: (name: string) => void
  submit?: KeiHandoff['submit']
  cancel?: KeiHandoff['cancel']
  poll?: KeiHandoff['poll']
  readArtifact?: () => Promise<Uint8Array>
  readPinnedDocument?: () => Promise<unknown>
  /** Runs a step's function this many times, as a crash between its commit and its checkpoint replays it. */
  runsOf?: (name: string) => number
}
function harness(scenario: Scenario = {}) {
  const admitted = scenario.admitted === undefined ? admittedExtraction() : scenario.admitted
  const artifact = scenario.artifact ?? (admitted && artifactFor(admitted))
  const bytes = scenario.bytes ?? bytesOf(artifact)
  const polls = scenario.polls ?? (admitted ? [{ state: 'SUCCESS' as const, output: extractOk(admitted, bytesOf(artifact), scenario.ok) }] : [])
  const steps: Array<{ name: string; config?: StepConfig }> = []
  const submissions: KeiSubmission[] = []
  const cancels: string[] = []
  const pollSignals: Array<AbortSignal | undefined> = []
  const artifactReads: Array<{ runId: string; extractionId: string; signal?: AbortSignal }> = []
  const results: Array<{ name: string; result: unknown }> = []
  const settles: SettledExtraction[] = []
  const signal = new AbortController().signal
  const row: { outcome: SettledExtraction | null } = { outcome: scenario.settled ?? null }
  let polled = 0
  const kei: KeiHandoff = {
    async submit(submission) { submissions.push(submission); await scenario.submit?.(submission) },
    poll: scenario.poll ?? (async (_workflowId, pollSignal) => {
      pollSignals.push(pollSignal)
      return polls[Math.min(polled++, polls.length - 1)]!
    }),
    async cancel(workflowId) { cancels.push(workflowId); await scenario.cancel?.(workflowId) },
    async requestDeleteRuns() { assert.fail('runExtraction never asks kei to delete runs.') },
  }
  const run = () => runExtractionWorkflow(admitted?.extractionId ?? 'deleted', {
    steps: {
      async step(name, fn, config) {
        steps.push({ name, config })
        scenario.beforeStep?.(name)
        let result = await fn()
        for (let run = 1; run < (scenario.runsOf?.(name) ?? 1); run += 1) result = await fn()
        results.push({ name, result })
        return result
      },
      cancelSignal: () => signal,
    },
    store: {
      loadAdmitted: async () => admitted,
      readPinnedDocument: scenario.readPinnedDocument ??
        (async () => (scenario.pinnedDocument === undefined ? parsedDocument : scenario.pinnedDocument)),
      settle: async (_id, settled) => {
        settles.push(settled)
        if (scenario.settle) return scenario.settle(settled)
        if (row.outcome) return 'already-settled'
        row.outcome = settled
        return 'settled'
      },
    },
    kei,
    readArtifact: async (runId, extractionId, readSignal) => {
      artifactReads.push({ runId, extractionId, signal: readSignal })
      return scenario.readArtifact ? scenario.readArtifact() : bytes
    },
  })
  return {
    admitted: admitted!, run, steps, submissions, cancels, pollSignals, artifactReads, settles, row, signal, results,
    names: () => steps.map((step) => step.name),
  }
}
const failureOf = (h: ReturnType<typeof harness>) => {
  assert.equal(h.settles.length, 1)
  const [settled] = h.settles
  assert.ok(settled && settled.outcome !== 'SUCCEEDED')
  return settled.failure
}

describe('runExtraction', () => {
  it('pins absent, null and empty model choices identically at admission', () => {
    for (const models of [undefined, null, {}, { fields: '' }, { fields: null }, { other: 'model' }])
      assert.deepEqual(extractionMethod('ARTICLE', undefined, models), {
        strategy: 'ARTICLE', catalogRecipe: null, requestedModels: null, requestedSettings: null,
      })
    assert.deepEqual(extractionMethod('CATALOG', '', { fields: ' field-model ' }), {
      strategy: 'CATALOG', catalogRecipe: '', requestedModels: { fields: ' field-model ' }, requestedSettings: null,
    })
  })

  it('submits an interactive Extraction to kei-extract at priority 1 and a batch member at 10, each with its strategy\'s deadline', async () => {
    const interactive = harness()
    await interactive.run()
    assert.deepEqual(interactive.submissions, [{
      workflow: 'extract', workflowId: `kei-extract:${interactive.admitted.extractionId}`, queueName: 'kei-extract',
      priority: 1, timeoutMs: 10_800_000, request: interactive.submissions[0]!.request,
      authenticatedUser: interactive.admitted.owner, attributes: extractionAttributes(interactive.admitted),
    }])
    assert.equal(interactive.submissions[0]!.attributes.keiRunId, RUN)
    const member = harness({ admitted: admittedExtraction({ strategy: 'CATALOG', batchExtractionId: randomUUID() }) })
    await member.run()
    const [submission] = member.submissions
    assert.equal(submission!.workflowId, `kei-extract:${member.admitted.extractionId}`)
    assert.equal(submission!.queueName, 'kei-extract')
    assert.equal(submission!.priority, 10)
    assert.equal(submission!.timeoutMs, 10_800_000)
    assert.equal(submission!.authenticatedUser, member.admitted.owner)
    assert.deepEqual(submission!.attributes, extractionAttributes(member.admitted))
    assert.equal(submission!.attributes.batchExtractionId, member.admitted.batchExtractionId)
    assert.equal(member.row.outcome?.outcome, 'SUCCEEDED')
  })

  it('names the Extraction\'s scope and kei run in its attributes', () => {
    const admitted = admittedExtraction()
    assert.deepEqual(extractionAttributes(admitted), {
      projectContextId: admitted.projectContextId, sourceDocumentId: admitted.sourceDocumentId,
      sourceRepresentationRevisionId: admitted.sourceRepresentationRevisionId,
      extractionSchemaId: admitted.extractionSchemaId, keiRunId: RUN,
    })
    const member = admittedExtraction({ batchExtractionId: 'batch', preprocessId: 'docling:x:y' })
    const attributes = extractionAttributes(member)
    assert.equal(attributes.batchExtractionId, 'batch')
    assert.equal('keiRunId' in attributes, false)
  })

  it('maps every admitted extraction method to the existing kei request shape', async () => {
    const recipe = 'numbered-catalogue-de@1'
    const cases: Array<{
      name: string
      strategy: ExtractionStrategy
      catalogRecipe: string | null
      requestedModels: AdmittedExtraction['requestedModels']
      options: Record<string, unknown>
    }> = [
      { name: 'Article without choices', strategy: 'ARTICLE', catalogRecipe: null, requestedModels: null, options: { strategy: 'article' } },
      { name: 'Article ignores a stored recipe', strategy: 'ARTICLE', catalogRecipe: recipe, requestedModels: null, options: { strategy: 'article' } },
      { name: 'Article empty roles', strategy: 'ARTICLE', catalogRecipe: null, requestedModels: {}, options: { strategy: 'article' } },
      { name: 'Article empty field role', strategy: 'ARTICLE', catalogRecipe: null, requestedModels: { fields: '' }, options: { strategy: 'article' } },
      { name: 'Article field role', strategy: 'ARTICLE', catalogRecipe: null, requestedModels: { fields: 'field-model' }, options: { strategy: 'article', models: { fields: 'field-model' } } },
      { name: 'Article ignores unknown role', strategy: 'ARTICLE', catalogRecipe: null, requestedModels: { other: 'other-model' } as AdmittedExtraction['requestedModels'], options: { strategy: 'article' } },
      { name: 'Catalog generic', strategy: 'CATALOG', catalogRecipe: null, requestedModels: null, options: { strategy: 'catalog' } },
      { name: 'Catalog empty recipe is retained', strategy: 'CATALOG', catalogRecipe: '', requestedModels: null, options: { strategy: 'catalog', catalog: { recipe: '' } } },
      { name: 'Catalog recipe and reasoning role', strategy: 'CATALOG', catalogRecipe: recipe, requestedModels: { reasoning: 'reasoning-model' }, options: { strategy: 'catalog', models: { reasoning: 'reasoning-model' }, catalog: { recipe } } },
      { name: 'Catalog both roles', strategy: 'CATALOG', catalogRecipe: recipe, requestedModels: { fields: 'field-model', reasoning: 'reasoning-model' }, options: { strategy: 'catalog', models: { fields: 'field-model', reasoning: 'reasoning-model' }, catalog: { recipe } } },
    ]
    for (const entry of cases) {
      const h = harness({ admitted: admittedExtraction({
        strategy: entry.strategy, catalogRecipe: entry.catalogRecipe, requestedModels: entry.requestedModels,
        preprocessId: `kei-exp:${RUN}:gen-7`,
      }) })
      await h.run()
      assert.deepEqual(h.submissions[0]!.request, {
        run_id: RUN, generation: 'gen-7', request: { schema, options: entry.options },
      }, entry.name)
    }
  })

  it('the submit step retries only while kei is not ready', async () => {
    const h = harness()
    await h.run()
    assert.equal(h.steps.find((step) => step.name === 'submitToKei')!.config, SUBMIT_TO_KEI_RETRY)
  })

  it('polls in bounded steps until kei finishes, then publishes the accepted artifact once', async () => {
    const admitted = admittedExtraction()
    const artifact = artifactFor(admitted)
    const h = harness({
      admitted,
      polls: [{ state: 'live' }, { state: 'live' }, { state: 'SUCCESS', output: extractOk(admitted, bytesOf(artifact)) }],
    })
    await h.run()
    assert.deepEqual(h.names(), ['loadAdmitted', 'submitToKei', 'pollKei', 'pollKei', 'pollKei', 'publishResult'])
    assert.equal(h.steps.at(-1)!.config, ARTIFACT_READ_RETRY)
    assert.deepEqual(h.artifactReads, [{ runId: RUN, extractionId: admitted.extractionId, signal: h.signal }])
    assert.equal(h.settles.length, 1)
    const settled = h.settles[0]!
    assert.equal(settled.outcome, 'SUCCEEDED')
    assert.ok(settled.outcome === 'SUCCEEDED')
    assert.equal(settled.extraction.extractionId, admitted.extractionId)
    assert.equal(settled.extraction.sourceRepresentationRevisionId, admitted.sourceRepresentationRevisionId)
    assert.deepEqual(settled.extraction.result, { records: [{ title: 'Alpha' }] })
    assert.deepEqual(settled.extraction.modelAttribution, { provider: 'kei-exp', modelId: 'fields-model' })
    assert.deepEqual(h.cancels, [])
  })

  it('the artifact read takes the step\'s cancel signal', async () => {
    const h = harness()
    await h.run()
    assert.equal(h.artifactReads.length, 1)
    assert.equal(h.artifactReads[0]!.signal, h.signal)
  })

  it('a publication replayed after its commit publishes once', async () => {
    const h = harness({ runsOf: (name) => (name === 'publishResult' ? 2 : 1) })
    await h.run()
    assert.deepEqual(h.settles.map((settled) => settled.outcome), ['SUCCEEDED', 'SUCCEEDED'])
    assert.equal(h.row.outcome?.outcome, 'SUCCEEDED')
    assert.deepEqual(h.results.at(-1), { name: 'publishResult', result: 'already-settled' })
    assert.deepEqual(h.cancels, [])
  })

  it('a revision deleted before publication publishes nothing and fails no step', async () => {
    const h = harness({ pinnedDocument: null })
    await h.run()
    assert.deepEqual(h.settles, [])
    assert.deepEqual(h.results.at(-1), { name: 'publishResult', result: 'missing' })
    assert.deepEqual(h.cancels, [])
  })

  it('an Extraction deleted before its outcome is written ends without another step', async () => {
    const h = harness({ settle: async () => 'missing' })
    await h.run()
    assert.equal(h.settles.length, 1)
    assert.equal(h.names().at(-1), 'publishResult')
    assert.deepEqual(h.cancels, [])
  })

  it('an artifact kei no longer serves fails the Extraction with a fixed message instead of stopping its workflow', async () => {
    const h = harness({
      readArtifact: async () => { throw new ExtractionError('extraction_failed', 'kei-exp has no published artifact for this Extraction.') },
    })
    await h.run()
    assert.deepEqual(failureOf(h), {
      code: 'extraction_failed', message: 'kei-exp has no published artifact for this Extraction.', phase: 'persisting',
    })
    assert.deepEqual(h.cancels, [])
  })

  it('a transient artifact read failure is thrown on for the step to retry', async () => {
    const transient = Object.assign(new Error('kei-exp returned HTTP 503.'), { transient: true })
    const h = harness({ readArtifact: async () => { throw transient } })
    await assert.rejects(h.run(), (error: unknown) => error === transient)
    assert.equal(ARTIFACT_READ_RETRY.shouldRetry!(transient), true)
    assert.deepEqual(h.settles, [])
  })

  it('a pinned package that cannot be read fails the Extraction with invalid_source_representation', async () => {
    const h = harness({
      readPinnedDocument: async () => {
        throw new ExtractionError('invalid_source_representation', 'The pinned Source Representation is unavailable.')
      },
    })
    await h.run()
    assert.deepEqual(failureOf(h), {
      code: 'invalid_source_representation', message: 'The pinned Source Representation is unavailable.', phase: 'persisting',
    })
    assert.deepEqual(h.cancels, [])
  })

  it('a replayed publication finds the Extraction settled and writes nothing new', async () => {
    const cancelled: SettledExtraction = { outcome: 'CANCELLED', failure: { code: 'cancelled', message: 'The Extraction was cancelled.', phase: 'extracting' } }
    const h = harness({ settled: cancelled })
    await h.run()
    assert.equal(h.row.outcome, cancelled)
    assert.equal(h.settles.length, 1)
    assert.deepEqual(h.cancels, [])
  })

  it('an Extraction deleted or settled before it runs submits nothing', async () => {
    const h = harness({ admitted: null })
    await h.run()
    assert.deepEqual(h.names(), ['loadAdmitted'])
    assert.deepEqual(h.submissions, [])
    assert.deepEqual(h.settles, [])
  })

  it('a representation that names no kei run fails with invalid_source_representation and submits nothing', async () => {
    const h = harness({ admitted: admittedExtraction({ preprocessId: 'docling:x:y' }) })
    await h.run()
    assert.deepEqual(h.submissions, [])
    assert.deepEqual(h.names(), ['loadAdmitted', 'publishFailure'])
    assert.equal(failureOf(h).code, 'invalid_source_representation')
  })

  it('a pinned schema that no longer parses fails with invalid_schema_revision and submits nothing', async () => {
    const h = harness({ admitted: admittedExtraction({ schemaTree: { recordDescription: 1 } }) })
    await h.run()
    assert.deepEqual(h.submissions, [])
    assert.equal(failureOf(h).code, 'invalid_schema_revision')
  })

  it('maps kei\'s failures to Studio\'s failure codes', async () => {
    const failed = (code: string, reason: string): KeiPoll => ({ state: 'SUCCESS', output: { ok: false, code, reason, retryable: false } })
    const cases: Array<[KeiPoll, string, string]> = [
      [failed('stale_generation', 'the run was re-parsed'), 'invalid_source_representation', 'the run was re-parsed'],
      [failed('model_unavailable', 'nuextract is not served'), 'model_unavailable', 'nuextract is not served'],
      [{ state: 'CANCELLED', deadlinePassed: false }, 'cancelled', 'The Extraction was cancelled.'],
      [failed('no_result', 'the run has no result'), 'extraction_failed', 'kei-exp could not complete the Extraction: the run has no result'],
      [{ state: 'SUCCESS', output: { ok: true, nonsense: 1 } }, 'invalid_model_output', 'The Parsing Service answered outside its contract.'],
      [{ state: 'ERROR', deadlinePassed: false }, 'extraction_failed', 'The Parsing Service stopped this Extraction.'],
      [{ state: 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', deadlinePassed: false }, 'extraction_failed', 'The Parsing Service stopped this Extraction.'],
      [{ state: 'missing' }, 'extraction_failed', 'The Parsing Service stopped this Extraction.'],
    ]
    for (const [poll, code, message] of cases) {
      const h = harness({ polls: [poll] })
      await h.run()
      assert.deepEqual(failureOf(h), { code, message, phase: 'extracting' }, code)
      assert.equal(h.names().at(-1), 'publishFailure')
      assert.deepEqual(h.artifactReads, [])
    }
    assert.equal(extractionFailureOf({ ok: false, code: 'no_result', reason: 'x'.repeat(600), retryable: false }, 'ARTICLE').message.length, 512)
  })

  it('a kei deadline becomes extraction_failed naming the time limit', async () => {
    for (const [strategy, limit] of [['CATALOG', '3 hours'], ['ARTICLE', '3 hours']] as const) {
      const h = harness({ admitted: admittedExtraction({ strategy }), polls: [{ state: 'CANCELLED', deadlinePassed: true }] })
      await h.run()
      assert.deepEqual(failureOf(h), {
        code: 'extraction_failed', message: `The Extraction did not finish within its time limit (${limit}).`, phase: 'extracting',
      })
    }
  })

  it('an artifact whose bytes do not hash to kei\'s artifact_sha256 fails with invalid_model_output', async () => {
    const admitted = admittedExtraction()
    const h = harness({ admitted, bytes: bytesOf({ ...artifactFor(admitted), records: [{ title: 'Tampered' }] }) })
    await h.run()
    assert.equal(failureOf(h).code, 'invalid_model_output')
    assert.equal(h.names().at(-1), 'publishResult')
  })

  it('kei\'s output must name this Extraction, its run and its generation', async () => {
    for (const ok of [{ extraction_id: randomUUID() }, { run_id: 'run-2' }, { generation: 'g2' }]) {
      const h = harness({ ok })
      await h.run()
      assert.equal(failureOf(h).code, 'invalid_model_output', JSON.stringify(ok))
      assert.deepEqual(h.artifactReads, [])
    }
  })

  it('an artifact kei-artifact refuses, or bytes that are not JSON, fail with kei\'s output named invalid', async () => {
    const admitted = admittedExtraction()
    const other = harness({ admitted, artifact: artifactFor(admitted, { strategy: 'catalog' }) })
    await other.run()
    assert.equal(failureOf(other).code, 'invalid_model_output')
    const garbled = new TextEncoder().encode('{"extraction_version":')
    const h = harness({ admitted, polls: [{ state: 'SUCCESS', output: extractOk(admitted, garbled) }], bytes: garbled })
    await h.run()
    // A fixed message: the JSON parser's own text never reaches a researcher.
    assert.deepEqual(failureOf(h), { code: 'invalid_model_output', message: 'kei-exp returned invalid JSON.', phase: 'persisting' })
  })

  it('a pinned package that is not a ParsedDocument v2 fails with invalid_source_representation', async () => {
    const h = harness({ pinnedDocument: { schema_version: 'parsed_document.v1' } })
    await h.run()
    assert.equal(failureOf(h).code, 'invalid_source_representation')
    assert.deepEqual(h.cancels, [])
  })

  it('an unexpected failure after submission cancels the kei child before rethrowing', async () => {
    const down = new Error('db down')
    const h = harness({ settle: async () => { throw down } })
    await assert.rejects(h.run(), (error: unknown) => error === down)
    assert.deepEqual(h.names().slice(-2), ['publishResult', 'cancelKeiChild'])
    assert.deepEqual(h.cancels, [`kei-extract:${h.admitted.extractionId}`])
  })

  it('an uncertain submission cancels its deterministic child and keeps the first failure', async () => {
    const lost = new Error('kei committed but the acknowledgement was lost')
    const h = harness({ submit: async () => { throw lost }, cancel: async () => { throw new Error('kei unavailable') } })
    const warn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args) => { warnings.push(args) }
    try {
      await assert.rejects(h.run(), (error: unknown) => error === lost)
    } finally { console.warn = warn }
    assert.deepEqual(h.names(), ['loadAdmitted', 'submitToKei', 'cancelKeiChild'])
    assert.deepEqual(h.cancels, [`kei-extract:${h.admitted.extractionId}`])
    assert.equal(h.row.outcome, null)
    assert.equal(warnings.length, 1)
  })

  it('a workflow cancellation propagates without another step', async () => {
    const cancelled = new DBOSErrors.DBOSWorkflowCancelledError('extract:x')
    const h = harness({ beforeStep: (name) => { if (name === 'pollKei') throw cancelled } })
    await assert.rejects(h.run(), (error: unknown) => error === cancelled)
    assert.deepEqual(h.names(), ['loadAdmitted', 'submitToKei', 'pollKei'])
    assert.deepEqual(h.cancels, [])
  })

  it('an aborted poll under a cancelled workflow rethrows without cancelling the child', async () => {
    const cancelled = new DBOSErrors.DBOSWorkflowCancelledError('extract:x')
    const h = harness({
      poll: async () => { throw new DOMException('This operation was aborted', 'AbortError') },
      beforeStep: (name) => { if (name === 'cancelKeiChild') throw cancelled },
    })
    await assert.rejects(h.run(), (error: unknown) => error === cancelled)
    assert.deepEqual(h.cancels, [])
  })

  it('the poll step waits on the step\'s cancel signal', async () => {
    const h = harness({ polls: [{ state: 'live' }, { state: 'CANCELLED', deadlinePassed: false }] })
    await h.run()
    assert.deepEqual(h.pollSignals, [h.signal, h.signal])
  })
})

const SPANS = {
  context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
  prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema',
} as const

describe('the admitted method', () => {
  it('is the only method kei is asked to run: the exact wire example', async () => {
    const admitted = admittedExtraction({ requestedModels: { fields: 'instruct', reasoning: 'instruct' }, requestedSettings: { article: SPANS } })
    const run = harness({ admitted })
    await run.run()
    assert.deepEqual((run.submissions[0]!.request as KeiExtractInput).request.options, {
      strategy: 'article', models: { fields: 'instruct', reasoning: 'instruct' }, article: SPANS,
    })
    assert.deepEqual(run.submissions[0]!.attributes, extractionAttributes(admitted))
  })

  it('a checkpoint written before settings were recorded builds the reference request', async () => {
    const { requestedSettings: _absent, ...older } = admittedExtraction()
    const run = harness({ admitted: older as AdmittedExtraction })
    await run.run()
    assert.deepEqual((run.submissions[0]!.request as KeiExtractInput).request.options, { strategy: 'article' })
    // The step sequence it was checkpointed under replays unchanged.
    assert.deepEqual(run.names(), ['loadAdmitted', 'submitToKei', 'pollKei', 'publishResult'])
    assert.equal(run.row.outcome?.outcome, 'SUCCEEDED')
  })

  it('an unreadable admitted method fails the Extraction, not the workflow, and asks kei for nothing', async () => {
    // No artifact is ever read: the default one is built from the admitted method, which does not read.
    const run = harness({ admitted: admittedExtraction({ requestedSettings: { generic: null } }), artifact: {} })
    await run.run()
    assert.equal(run.submissions.length, 0)
    assert.deepEqual(run.names(), ['loadAdmitted', 'publishFailure'])
    assert.deepEqual(run.settles, [{ outcome: 'FAILED', failure: {
      code: 'invalid_extraction_method', message: 'The admitted extraction method is invalid.', phase: 'loading' } }])
  })

  it('an artifact that ran another method is refused', async () => {
    const admitted = admittedExtraction({ requestedSettings: { article: SPANS } })
    const other = artifactFor(admittedExtraction({ requestedSettings: { article: { ...SPANS, grounding: 'quoted' } } }))
    const run = harness({ admitted, artifact: other })
    await run.run()
    assert.equal(run.settles[0]!.outcome, 'FAILED')
    assert.equal((run.settles[0] as { failure: { code: string } }).failure.code, 'invalid_model_output')
  })
})
