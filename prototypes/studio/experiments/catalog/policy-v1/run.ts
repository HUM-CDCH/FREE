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
import { schemaDefinition } from '../schema.js'
import { danish } from '../models-policy-v2/schemas.js'

const { values: args } = parseArgs({ options: {
  input: { type: 'string' },
  out: { type: 'string' },
  arm: { type: 'string', default: 'run' },
  /** beier: the frozen Beier schema; danish: the grave schema written for the Danish reports. */
  schema: { type: 'string', default: 'beier' },
  'batch-size': { type: 'string', default: '1' },
  'lexical-links': { type: 'boolean', default: false },
  'grounding-group': { type: 'string', default: '1' },
  'field-aware': { type: 'boolean', default: false },
  citations: { type: 'boolean', default: false },
  'citation-links': { type: 'boolean', default: false },
  'ground-always': { type: 'string', default: '' },
  'ground-multi-hit': { type: 'boolean', default: false },
  /** Replay discovery and values responses from this run directory (by request hash); grounding runs fresh. */
  replay: { type: 'string' },
  'values-model': { type: 'string', default: 'qwen' },
  'ground-model': { type: 'string', default: 'qwen' },
  /** Splice the prototype's synthetic examples into NuExtract values calls (Beier schema only). */
  'few-shot': { type: 'boolean', default: false },
  model: { type: 'string', default: 'qwen3.8:latest' },
  'nuextract-model': { type: 'string', default: 'hf.co/numind/NuExtract3-GGUF:Q4_K_M' },
  'ollama-url': { type: 'string', default: 'http://127.0.0.1:11434' },
  timeout: { type: 'string', default: '900000' },
  'job-timeout': { type: 'string', default: '10800000' },
} })
if (!args.input || !args.out) throw new Error('--input parsed_document.json and --out directory are required')
if (!['beier', 'danish'].includes(args.schema!) && !args.schema!.endsWith('.json')) throw new Error('--schema must be beier, danish or a .json schema definition')
/** A saved Studio schema revision ({ recordDescription, schemaNodes }) for acceptance runs on the real schema. */
const loaded = args.schema!.endsWith('.json') ? JSON.parse(await readFile(args.schema!, 'utf8')) : null
const definition: typeof schemaDefinition = args.schema === 'danish' ? danish as unknown as typeof schemaDefinition : args.schema === 'beier' ? schemaDefinition : { recordDescription: loaded.recordDescription, schemaNodes: loaded.schemaNodes }
if (typeof definition.recordDescription !== 'string' || !Array.isArray(definition.schemaNodes)) throw new Error('--schema file must hold recordDescription and schemaNodes')
const fields = definition.schemaNodes.map((node) => node.name)
for (const key of ['values-model', 'ground-model'] as const)
  if (!['qwen', 'nuextract'].includes(args[key]!)) throw new Error(`--${key} must be qwen or nuextract`)

/** Frozen together: the harness, the scoring inputs, and the production code it runs. */
export const FROZEN_FILES = [
  'experiments/catalog/policy-v1/run.ts',
  'experiments/catalog/schema.ts',
  'experiments/catalog/models-policy-v2/schemas.ts',
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
  citations: args.citations,
  citationLinks: args['citation-links'],
  groundAlways: args['ground-always'] ? args['ground-always'].split(',').map((field) => field.trim()).filter(Boolean) : [],
  groundMultiHit: args['ground-multi-hit'],
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
const groundTarget = args['ground-model'] === 'nuextract' ? nuextract : general

/** The prototype's synthetic two-record example (experiments/catalog/examples.ts),
 *  with routing identities when the batch template carries them. No Beier answers. */
function exampleBlock(template: Record<string, unknown>): string {
  const recordTemplate = (template.records as Record<string, unknown>[] | undefined)?.[0] ?? (template.record as Record<string, unknown> | undefined)
  if (!recordTemplate || !('catalog_number' in recordTemplate)) return ''
  const routed = 'record_id' in recordTemplate
  const values = [
    { catalog_number: 901, locality: 'Musterdorf', locality_part: null, findspot: '2. Sandgrube', map_sheet: 9999, find_type: 'G', burial_axis: 'N-S' },
    { catalog_number: 902, locality: 'Nebenort', locality_part: 'Westdorf', findspot: 'u.', map_sheet: 9998, find_type: 'EF', burial_axis: null },
  ]
  const slices = ['901. Musterdorf. Fdpl. 2. Sandgrube. Mbl. 9999 (0000).\nFA: G. Rechteckige Steinkiste; N-S.', '902. Nebenort, OT Westdorf. Fdpl. u. Mbl. 9998 (0001). FA: EF.']
  const input = routed ? slices.map((slice, i) => `### Record R${i + 1}\n${slice}`).join('\n\n') : slices.join('\n')
  const output = template.records
    ? { records: values.map((value, i) => routed ? { record_id: `R${i + 1}`, ...value } : value) }
    : { record: values[0] }
  return `【examples_start】\n【example_input_start】${input}【example_input_end】\n【example_output_start】${JSON.stringify(output)}【example_output_end】\n【examples_end】\n`
}

type Call = { index: number; phase: 'discovery' | 'extraction' | 'grounding'; model: string; status: 'failed' | 'succeeded'; durationMs: number; providerInvocations: number; metadata?: unknown; error?: string; claims?: number; claimLabels?: string[]; candidates?: number; records?: number; fallback?: boolean; replayed?: boolean }
/** Saved responses of another run, by the hash of the request that produced them. */
const replayed = new Map<string, { result: Record<string, unknown>; metadata: unknown }>()
if (args.replay) {
  const { readdir } = await import('node:fs/promises')
  for (const name of (await readdir(args.replay)).filter((file) => /^call-\d+-request\.json$/.test(file))) {
    const request = JSON.parse(await readFile(join(args.replay, name), 'utf8'))
    if (request.phase === 'grounding') continue
    const key = createHash('sha256').update(JSON.stringify({ phase: request.phase, markdown: request.document.markdown, template: request.template, instruction: request.instruction })).digest('hex')
    replayed.set(key, JSON.parse(await readFile(join(args.replay, name.replace('-request', '-response')), 'utf8')))
  }
}
/** Slices already sent inside a batch; a later single call for one of them is a rejected batch's fallback. */
const batchedSlices = new Set<string>()
const calls: Call[] = []
await save('manifest.json', { arm: args.arm, schema: args.schema, schemaSha256: args.schema!.endsWith('.json') ? createHash('sha256').update(await readFile(args.schema!)).digest('hex') : null, policy, model: args.model, valuesModel: args['values-model'], groundModel: args['ground-model'], fewShot: args['few-shot'], ollamaUrl: args['ollama-url'], inputSha256, hashes, schemaDefinition: definition, startedAt: new Date().toISOString() })

async function invoke(phase: Call['phase'], input: Omit<ExtractModelInput, 'signal'>, target: ExecutionTarget, extra: Partial<Call> = {}) {
  const index = calls.length + 1
  const prefix = join(out, `call-${String(index).padStart(3, '0')}`)
  const call: Call = { index, phase, model: target.attribution!.modelId, status: 'failed', durationMs: 0, providerInvocations: 1, ...extra }
  calls.push(call)
  await writeFile(`${prefix}-request.json`, JSON.stringify({ phase, ...input, outputSchema: input.outputSchema ? z.toJSONSchema(input.outputSchema) : null }, null, 2))
  console.log(`START ${index} ${phase} ${call.model}`)
  const begin = performance.now()
  if (args.replay && phase !== 'grounding') {
    // A replayed stage must match request for request; a miss is an error, never a fresh call.
    const key = createHash('sha256').update(JSON.stringify({ phase, markdown: input.document.markdown, template: input.template, instruction: input.instruction })).digest('hex')
    const saved = replayed.get(key)
    if (!saved) throw new Error(`Replay miss for ${phase} call ${index}: the request differs from every saved one in ${args.replay}`)
    call.status = 'succeeded'; call.replayed = true; call.providerInvocations = 0; call.metadata = saved.metadata
    await writeFile(`${prefix}-response.json`, JSON.stringify(saved, null, 2))
    console.log(`END ${index} replayed`)
    return saved as { result: Record<string, unknown>; metadata: never }
  }
  try {
    const fewShot = args['few-shot'] && phase === 'extraction' && target.profile === 'nuextract-raw'
    const response = await extractWithModel({ ...input, signal: AbortSignal.timeout(Number(args.timeout)) }, target, fewShot ? {
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body))
        body.prompt = String(body.prompt).replace('【document_start】', exampleBlock(input.template as Record<string, unknown>) + '【document_start】')
        await writeFile(`${prefix}-actual-request.json`, JSON.stringify(body, null, 2))
        return fetch(url, { ...init, body: JSON.stringify(body) })
      },
    } : {})
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
    async loadExtractionInputs() { return { sourceDocumentId: 'prototype-source', projectContextId: 'prototype', sourceRepresentationRevisionId: 'prototype-source-revision', schemaRevisionId: 'prototype-schema', schemaTree: definition, parsedDocument: document } },
    async readExtractionAttempt() { return null },
  },
  models: { async open() { return {
    attribution: { provider: 'ollama', modelId: `${args.model} discovery + ${valuesTarget.attribution!.modelId} values + ${groundTarget.attribution!.modelId} grounding` },
    model: { async extract(request: ExtractionModelRequest) {
      const discovery = 'starts' in request.template
      const batch = Array.isArray(request.template.records)
      const markdown = request.document.markdown
      let extra: Partial<Call> = {}
      if (!discovery && batch) {
        const slices = markdown.split(/^### Record R\d+\n/m).slice(1)
        for (const slice of slices) batchedSlices.add(slice.trim())
        extra = { records: slices.length }
      } else if (!discovery) {
        extra = { records: 1, fallback: batchedSlices.has(markdown.trim()) }
      }
      const response = await invoke(discovery ? 'discovery' : 'extraction', { document: { file: null, markdown, pages: request.document.pages }, template: request.template, instruction: request.instruction ?? '', outputSchema: request.outputSchema }, discovery ? general : valuesTarget, extra)
      return { result: response.result, metadata: response.metadata }
    } },
    groundingModel: { async ground(request) {
      const { signal, ...input } = groundingModelInput(request)
      void signal // invoke() attaches its own timeout signal
      const generated = await invoke('grounding', input, groundTarget, { claims: Object.keys(request.claims).length, claimLabels: Object.keys(request.claims), candidates: Object.keys(request.anchors).length })
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
  await save('result.json', { arm: args.arm, schema: args.schema, strategy: 'production', model: args.model, 'values-model': args['values-model'], 'ground-model': args['ground-model'], 'few-shot': args['few-shot'], 'batch-size': policy.recordBatchSize, policy, inputSha256, hashes, calls, boundaries: [], rows: [], failure: String(error), outcome: 'THREW', durationMs: Math.round(performance.now() - started) })
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
// Citations the values calls returned, counted from the saved responses.
const citationCount = calls.filter((call) => call.phase === 'extraction').length ? (await Promise.all(calls.filter((call) => call.phase === 'extraction').map(async (call) => {
  const response = JSON.parse(await readFile(join(out, `call-${String(call.index).padStart(3, '0')}-response.json`), 'utf8'))
  const rows = response.result?.records ?? (response.result?.record ? [response.result.record] : [])
  return rows.reduce((n: number, row: Record<string, unknown>) => n + Object.values((row._citations as Record<string, unknown>) ?? {}).flat().filter((label) => typeof label === 'string').length, 0)
}))).reduce((a, b) => a + b, 0) : 0
const sentToModel = calls.filter((call) => call.phase === 'grounding').reduce((sum, call) => sum + (call.claims ?? 0), 0)
await save('result.json', {
  arm: args.arm, schema: args.schema, strategy: 'production', model: args.model, 'values-model': args['values-model'], 'ground-model': args['ground-model'], 'few-shot': args['few-shot'], 'batch-size': policy.recordBatchSize, policy, inputSha256, hashes,
  calls, boundaries, rows, failure: terminal.failure, outcome: terminal.outcome, complete: terminal.complete, durationMs: Math.round(performance.now() - started),
  claims: { populated, sentToModel, lexicalLinks: populated - sentToModel, links: evidence.length, verbatimLinks: evidence.filter((link) => link.verbatim).length, ambiguousLinks: evidence.filter((link) => (link.lexicalHits ?? 0) > 1).length,
    citationLinks: evidence.filter((link) => link.linkedBy === 'citation_lexical').length, codeLexicalLinks: evidence.filter((link) => link.linkedBy === 'lexical').length, grounderLinks: evidence.filter((link) => !link.linkedBy).length,
    replayedCalls: calls.filter((call) => call.replayed).length, cited: citationCount },
  ungroundedPaths: terminal.diagnostics.ungroundedPaths,
  groundingIssues: terminal.diagnostics.groundingIssues,
  groundingBatches: terminal.diagnostics.groundingBatches.length,
  records: catalog?.records.map((record) => ({ ordinal: record.ordinal, outcome: record.outcome, calls: record.calls, failureCode: record.failureCode })) ?? [],
  stages: catalog?.stages.map((stage) => ({ stage: stage.stage, calls: stage.calls, durationMs: stage.durationMs, outcome: stage.outcome })) ?? [],
})
console.log('DONE', args.arm, terminal.outcome, `${boundaries.length} boundaries`, `${rows.length} rows`, `${calls.length} calls`, `${Math.round((performance.now() - started) / 1000)}s`)
