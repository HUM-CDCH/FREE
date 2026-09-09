/** Fresh production-policy execution, or hash-checked replay of unchanged stages. */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { createOllama } from 'ai-sdk-ollama'
import { z } from 'zod'
import { createExtractionJobExecutor } from '../../../../../packages/extraction/src/module.js'
import { decodeParsedDocument, type ParsedDocument } from '../../../../../packages/extraction/src/parsed-document.js'
import { canonicalSourceSlice, sourceContext } from '../../../../../packages/extraction/src/source-context.js'
import { partitionSchemaNodes, type SchemaNode } from '../../../../../packages/extraction/src/schema.js'
import type { CatalogBoundary } from '../../../../../packages/extraction/src/catalog-boundaries.js'
import type { ExtractionModelRequest, ExtractionModelResponse, ExtractionValueCheckpoint, GroundingModelRequest, TerminalExtraction } from '../../../../../packages/extraction/src/dependencies.js'
import { extractWithModel, type ExtractModelInput } from '../../../api/_model.js'
import type { ExecutionTarget } from '../../../api/_provider.js'
import { groundingModelInput, groundingSelections } from '../../../api/_grounding_prompt.js'
import { schemas, policy } from './schemas.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../../../..')
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const digest = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')
const exists = (path: string) => access(path).then(() => true, () => false)
async function save(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx' })
}

async function checkFreeze(root: string) {
  const frozen = await read(join(root, 'freeze.json'))
  if (process.version !== frozen.node) throw new Error('Frozen Node runtime changed')
  for (const [path, expected] of Object.entries(frozen.codeHashes))
    if (await digest(resolve(repo, path)) !== expected) throw new Error(`Frozen code changed: ${path}`)
  for (const [path, expected] of Object.entries(frozen.inputHashes))
    if (await digest(path) !== expected) throw new Error(`Frozen input changed: ${path}`)
  return frozen
}

type ImageRegion = { id: string; path: string; page: number; bboxPt: number[]; sha256: string }
type Trace = {
  index: number; phase: 'discovery' | 'document-values' | 'values' | 'grounding'; request: Record<string, unknown>; requestHash: string;
  status: 'succeeded' | 'failed'; origin: 'fresh' | 'replay' | 'native'; durationMs: number;
  records?: number; fallback?: boolean; error?: string; response?: ExtractionModelResponse;
  groundingRequest?: Omit<GroundingModelRequest, 'signal'>;
  ollamaRequests?: Record<string, unknown>[];
}
type NativeTask = {
  id: string; document: string; schema: string; repetition: number; baselineHash: string;
  records: { id: string; text: string }[]; fields: SchemaNode[];
  images: ImageRegion[]; queries: { id: string; text: string }[];
}
type NativeOutput = {
  inputHash: string;
  records?: Record<string, { values: Record<string, unknown>; error?: string }>;
  rankings?: Record<string, string[]>;
  measurements: Record<string, unknown>;
}

/** Match the executor's actual slices, without interpreting the source's numbering. */
export function identifySlices(markdown: string, slices: readonly { id: string; text: string }[]): string[] {
  const matches: string[][] = []
  for (let start = 0; start < slices.length; start++) {
    if (markdown === slices[start].text) matches.push([slices[start].id])
    for (let size = 2; size <= policy.recordBatchSize && start + size <= slices.length; size++) {
      const group = slices.slice(start, start + size)
      if (markdown === group.map((record, index) => `### Record R${index + 1}\n${record.text}`).join('\n\n'))
        matches.push(group.map((record) => record.id))
    }
  }
  if (matches.length !== 1) throw new Error(`Cannot unambiguously bind executor request to source records (${matches.length} matches)`)
  return matches[0]
}

export function nativeResponse(template: Record<string, unknown>, nodes: readonly SchemaNode[], ids: string[], records: NonNullable<NativeOutput['records']>): Record<string, unknown> {
  const batch = Array.isArray(template.records)
  const inner = (batch ? (template.records as unknown[])[0] : template.record) as Record<string, unknown>
  const routing = Object.keys(inner).filter((key) => !nodes.some((node) => node.name === key))
  if (batch && routing.length !== 1) throw new Error('Batch must have exactly one non-schema routing key')
  const values = ids.map((id, index) => {
    const record = records[id]
    if (!record || record.error) throw new Error(record?.error ?? `Missing native record ${id}`)
    return { ...(batch ? { [routing[0]]: `R${index + 1}` } : {}), ...record.values }
  })
  return batch ? { records: values } : { record: values[0] }
}

export function replayResponse(source: Trace | undefined, phase: Trace['phase'], requestHash: string) {
  if (!source || source.phase !== phase || source.requestHash !== requestHash) throw new Error('Replay request hash mismatch')
  if (source.status !== 'succeeded' || !source.response) throw new Error(source.error ?? 'Replayed upstream failure')
  return source.response
}

export function batchAccounting(markdown: string, batch: boolean, attempted: Set<string>) {
  const slices = batch ? markdown.split(/^### Record R\d+\n/m).slice(1) : []
  for (const slice of slices) attempted.add(slice.trim())
  return { records: slices.length || 1, fallback: slices.length === 0 && attempted.has(markdown.trim()) }
}

function recordAnchors(document: ParsedDocument, boundaries: readonly CatalogBoundary[]): Set<string>[] {
  return boundaries.map((boundary) => {
    const blocks = document.content_stream.slice(boundary.startContentIndex, boundary.endContentIndex)
    const ids = new Set(blocks.map((block) => block.block_id))
    const tables = new Set(blocks.flatMap((block) => block.kind === 'table' ? [block.table_id] : []))
    return new Set(document.evidence_index.anchors.filter((anchor) => anchor.kind === 'text' ? ids.has(anchor.block_id) : tables.has(anchor.logical_table_id)).map((anchor) => anchor.anchor_id))
  })
}

export function intersects(left: readonly number[], right: readonly number[]) {
  return left[0] < right[2] && right[0] < left[2] && left[1] < right[3] && right[1] < left[3]
}

export function retrievalCandidates(request: Omit<GroundingModelRequest, 'signal'>, document: ParsedDocument, boundaries: readonly CatalogBoundary[], nodes: readonly SchemaNode[], images: ImageRegion[], rankings: Record<string, string[]>, callIndex: number) {
  const context = sourceContext(document)
  const membership = recordAnchors(document, boundaries)
  const anchors = new Map(document.evidence_index.anchors.map((anchor) => [anchor.anchor_id, anchor]))
  const mapped = new Map([...context.anchorIdByLabel].map(([label, id]) => {
    const anchor = anchors.get(id)!
    const regions = images.filter((image) => anchor.producer_observations.some((observation) => observation.page_number === image.page &&
      intersects([observation.bbox.x0, observation.bbox.y0, observation.bbox.x1, observation.bbox.y1], image.bboxPt))).map((image) => image.id)
    return [label, regions] as const
  }))
  const allowed: Record<string, string[]> = {}
  for (const claim of Object.keys(request.claims)) {
    const field = request.claimFields?.[claim]
    const index = field?.record ? Number(/^records\[(\d+)\]$/.exec(field.record)?.[1]) : null
    const documentField = nodes.some((node) => node.name === field?.field && node.valueSource === 'document')
    const top = new Set((rankings[`${callIndex}:${claim}`] ?? []).slice(0, 3))
    if (!rankings[`${callIndex}:${claim}`]) throw new Error(`Missing ranking for ${callIndex}:${claim}`)
    allowed[claim] = Object.keys(request.anchors).filter((label) => {
      const id = context.anchorIdByLabel.get(label)
      if (!id || (!documentField && index !== null && !membership[index]?.has(id))) return false
      const regions = mapped.get(label) ?? []
      return regions.length === 0 || regions.some((region) => top.has(region))
    })
  }
  const union = new Set(Object.values(allowed).flat())
  return { allowed, allowedAnchorIds: Object.fromEntries(Object.entries(allowed).map(([claim, labels]) => [claim, labels.map((label) => context.anchorIdByLabel.get(label)!)])),
    anchors: Object.fromEntries(Object.entries(request.anchors).filter(([label]) => union.has(label))),
    unmappedAnchors: [...union].filter((label) => (mapped.get(label) ?? []).length === 0).length }
}

async function prepareNative(root: string, doc: string, schema: keyof typeof schemas, rep: number, arm: string) {
  await checkFreeze(root)
  const baseline = join(root, 'runs', doc, schema, `baseline-r${rep}`)
  const traces: Trace[] = await read(join(baseline, 'calls.json'))
  const document = decodeParsedDocument(await read(join(root, 'inputs', doc, 'baseline/parsed_document.json')))
  const terminal: TerminalExtraction | null = await exists(join(baseline, 'terminal.json')) ? await read(join(baseline, 'terminal.json')) : null
  const boundaries = terminal?.diagnostics.catalog?.records.map((record) => record.boundary) ?? []
  const successful = terminal?.diagnostics.catalog?.records.filter((record) => record.outcome === 'succeeded').map((record) => record.boundary) ?? []
  const id = `${doc}/${schema}/r${rep}`
  const task: NativeTask = { id, document: doc, schema, repetition: rep,
    baselineHash: await digest(join(baseline, 'calls.json')),
    fields: partitionSchemaNodes(schemas[schema].schemaNodes as SchemaNode[]).recordNodes,
    records: boundaries.map((boundary) => ({ id: boundary.startBlockId, text: canonicalSourceSlice(document, boundary.startContentIndex, boundary.endContentIndex) })),
    images: await read(join(root, 'inputs', doc, 'images.json')), queries: [] }
  for (const trace of traces.filter((call) => call.phase === 'grounding')) {
    const request = trace.groundingRequest!
    for (const [label, value] of Object.entries(request.claims)) {
      const field = request.claimFields?.[label]
      const recordIndex = field?.record ? Number(/^records\[(\d+)\]$/.exec(field.record)?.[1]) : null
      const boundary = recordIndex === null ? null : successful[recordIndex]
      const heading = recordIndex === null ? 'document-level field' : boundary ? canonicalSourceSlice(document, boundary.startContentIndex, boundary.endContentIndex).slice(0, 300) : field!.record
      const description = field?.description || schemas[schema].recordDescription
      task.queries.push({ id: `${trace.index}:${label}`, text: `Find source evidence for ${field?.field ?? label} (${description}), proposed value ${JSON.stringify(value)}, in record ${heading}.` })
    }
  }
  await save(join(root, 'native-inputs', arm, `${doc}-${schema}-r${rep}.json`), task)
}

async function execute(root: string, doc: string, schema: keyof typeof schemas, arm: string, rep: number) {
  const freeze = await checkFreeze(root)
  const baseline = join(root, 'runs', doc, schema, `baseline-r${rep}`)
  const out = join(root, 'runs', doc, schema, `${arm}-r${rep}`)
  if (await exists(out)) throw new Error(`Refusing to reuse ${out}`)
  const inputPath = join(root, 'inputs', doc, ['hunyuan', 'nanonets', 'navidc', 'nemotron'].includes(arm) ? arm : 'baseline', 'parsed_document.json')
  const document = decodeParsedDocument(await read(inputPath))
  const inputHash = await digest(inputPath)
  // Derived OCR inputs are frozen in their manifest after raw generation.
  const expectedInput = arm === 'baseline' || ['evie', 'neomme', 'gliner'].includes(arm)
    ? freeze.inputHashes[inputPath.replaceAll('\\', '/')]
    : (await read(join(dirname(inputPath), 'manifest.json'))).sha256
  if (inputHash !== expectedInput) throw new Error('Input differs from frozen or derived-input manifest')
  if (['hunyuan', 'nanonets', 'navidc', 'nemotron'].includes(arm)) {
    const derived = await read(join(dirname(inputPath), 'manifest.json'))
    for (const [path, expected] of Object.entries(derived.rawHashes))
      if (await digest(path) !== expected) throw new Error('Derived OCR raw output changed')
  }
  const replay = ['evie', 'neomme', 'gliner'].includes(arm)
  const traces: Trace[] = replay ? await read(join(baseline, 'calls.json')) : []
  let native: NativeOutput | null = null
  let nativeTask: NativeTask | null = null
  if (replay) {
    const taskPath = join(root, 'native-inputs', arm, `${doc}-${schema}-r${rep}.json`)
    nativeTask = await read(taskPath)
    native = await read(join(root, 'native-outputs', arm, `${doc}-${schema}-r${rep}.json`))
    if (native!.inputHash !== await digest(taskPath) || nativeTask!.baselineHash !== await digest(join(baseline, 'calls.json')))
      throw new Error('Native input or baseline trace changed')
  }
  const model = freeze.qwen
  const inventory = await fetch(`${model.baseUrl}/api/tags`, { signal: AbortSignal.timeout(10000) }).then((response) => response.json())
  if (!inventory.models?.some((entry: { name: string; digest: string }) => entry.name === model.name && entry.digest === model.digest))
    throw new Error('Qwen model digest changed or model is absent')
  const calls: Trace[] = []
  const measuredFetch: typeof fetch = async (url, options) => {
    const response = await fetch(url, options)
    const trace = calls.at(-1)
    if (trace) {
      const metrics: Record<string, unknown> = { httpStatus: response.status }
      try {
        const text = await response.clone().text()
        let body: Record<string, unknown>
        try { body = JSON.parse(text) } catch { body = JSON.parse(text.trim().split('\n').at(-1)!) }
        for (const key of ['total_duration', 'load_duration', 'prompt_eval_duration', 'eval_duration', 'prompt_eval_count', 'eval_count', 'done_reason'])
          if (key in body) metrics[key] = body[key]
      } catch { metrics.warning = 'Ollama timing payload unavailable' }
      ;(trace.ollamaRequests ??= []).push(metrics)
    }
    return response
  }
  const target: ExecutionTarget = { profile: 'general', model: createOllama({ baseURL: model.baseUrl, fetch: measuredFetch })(model.name),
    jsonOutput: 'native', temperatureSupported: true, attribution: { provider: 'ollama', modelId: model.name } }
  const definition = schemas[schema]
  const attemptedBatches = new Set<string>()
  let checkpoint: ExtractionValueCheckpoint | null = null
  let replayCursor = 0
  const controller = AbortSignal.timeout(10800000)
  await mkdir(out, { recursive: true })
  await save(join(out, 'manifest.json'), { doc, schema, arm, repetition: rep, policy, inputHash, model,
    freezeSha256: await digest(join(root, 'freeze.json')), startedAt: new Date().toISOString(),
    baseline: replay ? baseline : null, native: native?.measurements ?? null })

  async function invoke(phase: Trace['phase'], input: Omit<ExtractModelInput, 'signal'>, extra: Partial<Trace> = {}, responseOverride?: () => ExtractionModelResponse): Promise<ExtractionModelResponse> {
    const request = JSON.parse(JSON.stringify({ ...input, outputSchema: input.outputSchema ? z.toJSONSchema(input.outputSchema) : null }))
    const trace: Trace = { index: calls.length + 1, phase, request, requestHash: hash(request), status: 'failed', origin: 'fresh', durationMs: 0, ...extra }
    calls.push(trace)
    const started = performance.now()
    console.log('START', arm, doc, schema, rep, trace.index, phase)
    try {
      const shouldReplay = replay && (phase === 'discovery' || phase === 'document-values' || (phase === 'values' && arm !== 'gliner'))
      if (shouldReplay) {
        const source = traces.filter((entry) => entry.phase !== 'grounding' && (arm !== 'gliner' || entry.phase !== 'values'))[replayCursor++]
        trace.origin = 'replay'
        trace.response = replayResponse(source, phase, trace.requestHash)
      } else if (responseOverride) {
        trace.origin = 'native'
        trace.response = responseOverride()
      } else {
        trace.response = await extractWithModel({ ...input, signal: AbortSignal.any([controller, AbortSignal.timeout(900000)]) }, target)
      }
      trace.status = 'succeeded'
      return trace.response
    } catch (error) {
      trace.error = String(error)
      throw error
    } finally {
      trace.durationMs = Math.round(performance.now() - started)
      await save(join(out, `call-${String(trace.index).padStart(3, '0')}.json`), trace)
      console.log('END', trace.index, trace.status, trace.origin, trace.durationMs)
    }
  }

  const executor = createExtractionJobExecutor({
    inputs: { async loadExtractionInputs() { return { sourceDocumentId: doc, projectContextId: 'models-policy-v2',
      sourceRepresentationRevisionId: inputHash, schemaRevisionId: schema, schemaTree: definition, parsedDocument: document } },
      async readExtractionAttempt() { return null } },
    models: { async open() { return {
      attribution: { provider: 'experiment', modelId: `${model.name}/${arm}` },
      model: { async extract(request: ExtractionModelRequest) {
        const template = request.template as Record<string, unknown>
        const discovery = 'starts' in template
        const documentOnly = !discovery && Object.keys((template.record ?? {}) as object).every((key) => (definition.schemaNodes as SchemaNode[]).some((node) => node.name === key && node.valueSource === 'document')) && !template.records
        const phase = discovery ? 'discovery' : documentOnly ? 'document-values' : 'values'
        const markdown = request.document.markdown
        return invoke(phase, { document: { file: null, markdown, pages: request.document.pages }, template,
          instruction: request.instruction ?? '', outputSchema: request.outputSchema },
          phase === 'values' ? batchAccounting(markdown, Array.isArray(template.records), attemptedBatches) : {},
          phase === 'values' && arm === 'gliner' ? () => ({ result: nativeResponse(template,
            partitionSchemaNodes(definition.schemaNodes as SchemaNode[]).recordNodes,
            identifySlices(markdown, nativeTask!.records), native!.records!),
            metadata: { finishReason: 'stop', inputTokens: null, outputTokens: null, durationMs: null } }) : undefined)
      } },
      groundingModel: { async ground(request: GroundingModelRequest) {
        const { signal, ...originalRequest } = request
        void signal
        let selectedRequest = request
        let permitted: ReturnType<typeof retrievalCandidates> | null = null
        let sourceIndex = 0
        if (arm === 'evie' || arm === 'neomme') {
          const originalTrace = traces.find((entry) => entry.phase === 'grounding' && hash(entry.groundingRequest) === hash(originalRequest))
          if (!originalTrace) throw new Error('Grounding replay request differs from baseline')
          sourceIndex = originalTrace.index
          const boundaries = checkpoint?.diagnostics.catalog?.records.filter((record) => record.outcome === 'succeeded').map((record) => record.boundary) ?? []
          permitted = retrievalCandidates(originalRequest, document, boundaries, definition.schemaNodes as SchemaNode[], nativeTask!.images, native!.rankings!, sourceIndex)
          selectedRequest = { ...request, anchors: permitted.anchors }
        }
        const { signal: inputSignal, ...input } = groundingModelInput(selectedRequest)
        void inputSignal
        const generated = await invoke('grounding', input, { groundingRequest: originalRequest })
        const selections = groundingSelections(generated.result)
        if (permitted) {
          const rejected = selections.filter((selection) => selection.anchorLabel !== null && !permitted!.allowed[selection.claimLabel]?.includes(selection.anchorLabel))
          await save(join(out, `retrieval-${sourceIndex}.json`), { ...permitted, rejected,
            originalCandidates: Object.keys(request.anchors).length, selectedCandidates: Object.keys(permitted.anchors).length })
          for (const selection of rejected) selection.anchorLabel = null
        }
        return { selections, metadata: generated.metadata }
      } },
    } } }, policy,
  })
  const begin = performance.now()
  let peakDeviceMemoryMiB: number | null = null
  let sample: Promise<void> | null = null
  const sampleGpu = () => {
    if (sample) return
    sample = promisify(execFile)('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { windowsHide: true })
      .then(({ stdout }) => { const value = Number(stdout.trim().split('\n')[0]); if (Number.isFinite(value)) peakDeviceMemoryMiB = Math.max(peakDeviceMemoryMiB ?? 0, value) })
      .catch(() => {}).finally(() => { sample = null })
  }
  sampleGpu()
  const sampling = setInterval(sampleGpu, 1000)
  let terminal: TerminalExtraction | null = null
  let error: string | null = null
  try {
    terminal = await executor({ kind: 'fresh', extractionId: `${arm}-r${rep}`, sourceRepresentationRevisionId: inputHash,
      schemaRevisionId: schema, strategy: 'CATALOG' }, null, async (value) => { checkpoint = value; await save(join(out, 'checkpoint.json'), value) }, controller)
    await save(join(out, 'terminal.json'), terminal)
  } catch (caught) { error = String(caught) }
  finally { clearInterval(sampling); await sample }
  await save(join(out, 'calls.json'), calls)
  await save(join(out, 'result.json'), { doc, schema, arm, repetition: rep, outcome: terminal?.outcome ?? 'THREW', error,
    inputHash, policy, wallMs: Math.round(performance.now() - begin), freshModelCalls: calls.filter((call) => call.origin === 'fresh').length,
    peakDeviceMemoryMiB, gpuSamplingIntervalMs: 1000, gpuMemoryNote: 'Sampled whole-device memory, including desktop; not a model allocation peak.',
    replayedCalls: calls.filter((call) => call.origin === 'replay').length, nativeAdapterCalls: calls.filter((call) => call.origin === 'native').length,
    fallbackCalls: calls.filter((call) => call.fallback).length, native: native?.measurements ?? null })
  console.log('DONE', doc, schema, arm, rep, terminal?.outcome ?? 'THREW')
}

async function main() {
  const { values } = parseArgs({ options: { root: { type: 'string', default: resolve(repo, 'artifacts/catalog-lab/models-policy-v2') },
    document: { type: 'string' }, schema: { type: 'string', default: 'beier' }, arm: { type: 'string', default: 'baseline' },
    repetition: { type: 'string', default: '1' }, 'prepare-native': { type: 'boolean', default: false },
    'emit-schemas': { type: 'boolean', default: false }, 'check-inputs': { type: 'boolean', default: false } } })
  const root = resolve(values.root!)
  if (values['emit-schemas']) { await save(join(root, 'schemas.json'), { schemas, policy }); return }
  if (values['check-inputs']) {
    const { glob } = await import('node:fs/promises')
    let count = 0
    for await (const path of glob('inputs/*/*/parsed_document.json', { cwd: root })) { decodeParsedDocument(await read(join(root, path))); count++ }
    console.log('Valid canonical inputs:', count); return
  }
  if (!values.document || !['beier', 'danish'].includes(values.schema!) || !['baseline', 'hunyuan', 'nanonets', 'navidc', 'nemotron', 'evie', 'neomme', 'gliner'].includes(values.arm!)) throw new Error('Invalid document/schema/arm')
  const rep = Number(values.repetition)
  if (![1, 2].includes(rep)) throw new Error('This frozen protocol has repetitions 1 and 2')
  if (values['prepare-native']) await prepareNative(root, values.document, values.schema as keyof typeof schemas, rep, values.arm!)
  else await execute(root, values.document, values.schema as keyof typeof schemas, values.arm!, rep)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
