/** The production Catalog executor under one CatalogPolicy; no application writes.
 *  Every request and response is saved; the output directory is never reused. */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createOllama } from 'ai-sdk-ollama'
import { z } from 'zod'
import { createExtractionJobExecutor } from '../../../../../packages/extraction/src/module.js'
import { decodeParsedDocument } from '../../../../../packages/extraction/src/parsed-document.js'
import { parseCatalogPolicy } from '../../../../../packages/extraction/src/catalog.js'
import { populatedContentPaths } from '../../../../../packages/extraction/src/grounding.js'
import type { ExtractionModelRequest, TerminalExtraction } from '../../../../../packages/extraction/src/dependencies.js'
import { extractWithModel, type ExtractModelInput } from '../../../api/_model.js'
import type { ExecutionTarget } from '../../../api/_provider.js'
import { groundingModelInput, groundingSelections } from '../../../api/_grounding_prompt.js'
import { fields, schemaDefinition } from '../schema.js'

const { values: args } = parseArgs({ options: {
  input: { type: 'string' },
  out: { type: 'string' },
  arm: { type: 'string', default: 'run' },
  'batch-size': { type: 'string', default: '1' },
  'lexical-links': { type: 'boolean', default: false },
  'grounding-group': { type: 'string', default: '1' },
  'field-aware': { type: 'boolean', default: false },
  'values-model': { type: 'string', default: 'qwen' },
  model: { type: 'string', default: 'qwen3.8:latest' },
  'nuextract-model': { type: 'string', default: 'hf.co/numind/NuExtract3-GGUF:Q4_K_M' },
  'ollama-url': { type: 'string', default: 'http://127.0.0.1:11434' },
  timeout: { type: 'string', default: '900000' },
  'job-timeout': { type: 'string', default: '10800000' },
} })
if (!args.input || !args.out) throw new Error('--input parsed_document.json and --out directory are required')
if (!['qwen', 'nuextract'].includes(args['values-model']!)) throw new Error('--values-model must be qwen or nuextract')

/** Frozen together: the harness, the scoring inputs, and the production code it runs. */
export const FROZEN_FILES = [
  'experiments/catalog/policy-v1/run.ts',
  'experiments/catalog/schema.ts',
  'experiments/catalog/evaluate.py',
  'experiments/catalog/beier.reference.json',
  'api/_model.ts',
  'api/_grounding_prompt.ts',
  '../../packages/extraction/src/module.ts',
  '../../packages/extraction/src/grounding.ts',
  '../../packages/extraction/src/lexical.ts',
  '../../packages/extraction/src/catalog.ts',
  '../../packages/extraction/src/schema.ts',
  '../../packages/extraction/src/source-context.ts',
  '../../packages/extraction/src/catalog-discovery.ts',
  '../../packages/extraction/src/catalog-boundaries.ts',
]
const hashes = Object.fromEntries(await Promise.all(FROZEN_FILES.map(async (path) => [path, createHash('sha256').update(await readFile(path)).digest('hex')])))

const policy = parseCatalogPolicy({
  recordBatchSize: Number(args['batch-size']),
  lexicalLinks: args['lexical-links'],
  groundingGroupSize: Number(args['grounding-group']),
  fieldAwareGrounding: args['field-aware'],
})
const out = resolve(args.out)
if (await access(out).then(() => true, () => false)) throw new Error(`Refusing to reuse ${out}`)
await mkdir(out, { recursive: true })
const bytes = await readFile(resolve(args.input))
const document = decodeParsedDocument(JSON.parse(bytes.toString()))
const inputSha256 = createHash('sha256').update(bytes).digest('hex')
const save = (name: string, value: unknown) => writeFile(join(out, name), JSON.stringify(value, null, 2))

const general: ExecutionTarget = {
  profile: 'general',
  model: createOllama({ baseURL: args['ollama-url']! })(args.model!),
  jsonOutput: 'native',
  temperatureSupported: true,
  attribution: { provider: 'ollama', modelId: args.model! },
}
const nuextract: ExecutionTarget = {
  profile: 'nuextract-raw',
  modelId: args['nuextract-model']!,
  baseUrl: args['ollama-url']!,
  authorization: null,
  temperatureSupported: true,
  attribution: { provider: 'ollama', modelId: args['nuextract-model']! },
}
const valuesTarget = args['values-model'] === 'nuextract' ? nuextract : general

type Call = { index: number; phase: 'discovery' | 'extraction' | 'grounding'; model: string; status: 'failed' | 'succeeded'; durationMs: number; providerInvocations: number; metadata?: unknown; error?: string; claims?: number; claimLabels?: string[]; candidates?: number; records?: number }
const calls: Call[] = []
await save('manifest.json', { arm: args.arm, policy, model: args.model, valuesModel: args['values-model'], ollamaUrl: args['ollama-url'], inputSha256, hashes, schemaDefinition, startedAt: new Date().toISOString() })

async function invoke(phase: Call['phase'], input: Omit<ExtractModelInput, 'signal'>, target: ExecutionTarget, extra: Partial<Call> = {}) {
  const index = calls.length + 1
  const prefix = join(out, `call-${String(index).padStart(3, '0')}`)
  const call: Call = { index, phase, model: target.attribution!.modelId, status: 'failed', durationMs: 0, providerInvocations: 1, ...extra }
  calls.push(call)
  await writeFile(`${prefix}-request.json`, JSON.stringify({ phase, ...input, outputSchema: input.outputSchema ? z.toJSONSchema(input.outputSchema) : null }, null, 2))
  console.log(`START ${index} ${phase} ${call.model}`)
  const begin = performance.now()
  try {
    const response = await extractWithModel({ ...input, signal: AbortSignal.timeout(Number(args.timeout)) }, target)
    call.status = 'succeeded'
    call.metadata = response.metadata
    await writeFile(`${prefix}-response.json`, JSON.stringify({ result: response.result, metadata: response.metadata }, null, 2))
    return response
  } catch (error) {
    call.error = error instanceof Error ? error.message : String(error)
    await writeFile(`${prefix}-error.json`, JSON.stringify({ error: call.error }, null, 2))
    throw error
  } finally {
    call.durationMs = Math.round(performance.now() - begin)
    await save('calls.json', calls)
    console.log(`END ${index} ${call.status} ${call.durationMs}ms`)
  }
}

const execute = createExtractionJobExecutor({
  inputs: {
    async loadExtractionInputs() { return { sourceDocumentId: 'prototype-source', projectContextId: 'prototype', sourceRepresentationRevisionId: 'prototype-source-revision', schemaRevisionId: 'prototype-schema', schemaTree: schemaDefinition, parsedDocument: document } },
    async readExtractionAttempt() { return null },
  },
  models: { async open() { return {
    attribution: { provider: 'ollama', modelId: `${args.model} discovery/grounding + ${args['values-model'] === 'nuextract' ? args['nuextract-model'] : args.model} values` },
    model: { async extract(request: ExtractionModelRequest) {
      const discovery = 'starts' in request.template
      const batch = Array.isArray(request.template.records)
      const response = await invoke(discovery ? 'discovery' : 'extraction', { document: { file: null, markdown: request.document.markdown, pages: request.document.pages }, template: request.template, instruction: request.instruction ?? '', outputSchema: request.outputSchema }, discovery ? general : valuesTarget, discovery ? {} : { records: batch ? (request.document.markdown.match(/^### Record R\d+$/gm) ?? []).length : 1 })
      return { result: response.result, metadata: response.metadata }
    } },
    groundingModel: { async ground(request) {
      const { signal, ...input } = groundingModelInput(request)
      void signal // invoke() attaches its own timeout signal
      const generated = await invoke('grounding', input, general, { claims: Object.keys(request.claims).length, claimLabels: Object.keys(request.claims), candidates: Object.keys(request.anchors).length })
      return { selections: groundingSelections(generated.result), metadata: generated.metadata }
    } },
  } } },
  policy,
})

const started = performance.now()
let terminal: TerminalExtraction
try {
  terminal = await execute({ kind: 'fresh', extractionId: 'prototype-run', sourceRepresentationRevisionId: 'prototype-source-revision', schemaRevisionId: 'prototype-schema', strategy: 'CATALOG' }, null,
    (checkpoint) => save('checkpoint.json', checkpoint), AbortSignal.timeout(Number(args['job-timeout'])))
} catch (error) {
  await save('result.json', { arm: args.arm, strategy: 'production', model: args.model, 'values-model': args['values-model'], 'batch-size': policy.recordBatchSize, policy, inputSha256, hashes, calls, boundaries: [], rows: [], failure: String(error), outcome: 'THREW', durationMs: Math.round(performance.now() - started) })
  console.log('THREW', String(error))
  process.exit(1)
}
await save('terminal.json', terminal)
const catalog = terminal.diagnostics.catalog
const boundaries = catalog?.records.map((record) => record.boundary) ?? []
const evidence = terminal.evidence ?? []
const rows = (terminal.result?.records as Record<string, unknown>[] ?? []).map((values, index) => ({
  values,
  evidence: Object.fromEntries(fields.map((field) => [field, evidence.filter((link) => link.resultPath[1] === index && link.resultPath[2] === field).map((link) => link.evidenceAnchorId)])),
  issues: [],
}))
const populated = terminal.result ? populatedContentPaths(terminal.result).length : 0
const sentToModel = calls.filter((call) => call.phase === 'grounding').reduce((sum, call) => sum + (call.claims ?? 0), 0)
await save('result.json', {
  arm: args.arm, strategy: 'production', model: args.model, 'values-model': args['values-model'], 'batch-size': policy.recordBatchSize, policy, inputSha256, hashes,
  calls, boundaries, rows, failure: terminal.failure, outcome: terminal.outcome, complete: terminal.complete, durationMs: Math.round(performance.now() - started),
  claims: { populated, sentToModel, lexicalLinks: populated - sentToModel, links: evidence.length, verbatimLinks: evidence.filter((link) => link.verbatim).length, ambiguousLinks: evidence.filter((link) => (link.lexicalHits ?? 0) > 1).length },
  ungroundedPaths: terminal.diagnostics.ungroundedPaths,
  groundingIssues: terminal.diagnostics.groundingIssues,
  groundingBatches: terminal.diagnostics.groundingBatches.length,
  records: catalog?.records.map((record) => ({ ordinal: record.ordinal, outcome: record.outcome, calls: record.calls, failureCode: record.failureCode })) ?? [],
  stages: catalog?.stages.map((stage) => ({ stage: stage.stage, calls: stage.calls, durationMs: stage.durationMs, outcome: stage.outcome })) ?? [],
})
console.log('DONE', args.arm, terminal.outcome, `${boundaries.length} boundaries`, `${rows.length} rows`, `${calls.length} calls`, `${Math.round((performance.now() - started) / 1000)}s`)
