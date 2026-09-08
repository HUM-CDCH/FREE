/** Disposable Catalog experiment. Run from Studio; no database or product configuration writes. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { extractWithModel, type ExtractModelInput } from '../../api/_model.js'
import { clearInspector, inspectorResponse } from '../../api/_llm_inspector.js'
import { readModelConfig } from '../../api/_model_config.js'
import { closeProviderRuntime, resolveCapabilityRoute, type ExecutionTarget } from '../../api/_provider.js'
import { createExtractionJobExecutor } from '../../../../packages/extraction/src/module.js'
import { groundExtraction } from '../../../../packages/extraction/src/grounding.js'
import { decodeParsedDocument } from '../../../../packages/extraction/src/parsed-document.js'
import { canonicalSourceSlice, canonicalAnchorInventory, catalogDiscoveryChunks, sourceContext } from '../../../../packages/extraction/src/source-context.js'
import { resolveCatalogBoundaries, type CatalogBoundary } from '../../../../packages/extraction/src/catalog-boundaries.js'
import type { GroundingModel, ExtractionModelRequest } from '../../../../packages/extraction/src/dependencies.js'
import { fields, valueTemplate, schemaDefinition, recordDescription, jointInstruction, jointTemplate } from './schema.js'
import { lexicalCandidates } from './link.js'
import { exampleBlock } from './examples.js'

const { values: args } = parseArgs({ options: {
  input: { type: 'string' }, out: { type: 'string' }, strategy: { type: 'string', default: 'baseline' },
  model: { type: 'string', default: 'nuextract' }, 'ground-model': { type: 'string' },
  'discovery-from': { type: 'string' }, 'batch-size': { type: 'string', default: '5' },
  'development-only': { type: 'boolean', default: false },
  'few-shot': { type: 'boolean', default: false }, 'field-aware': { type: 'boolean', default: false },
  'fallback-model': { type: 'string' },
  'ollama-url': { type: 'string', default: 'http://spark.cdch-dgxspark.lan.ku.dk:11434' },
  timeout: { type: 'string', default: '180000' },
} })
if (!args.input || !args.out) throw new Error('Required: --input parsed_document.json --out new-output-directory')
const strategies = ['baseline', 'separate', 'joint', 'grouped-joint', 'grouped-lexical', 'chunk-joint', 'rule-grouped-lexical']
if (!strategies.includes(args.strategy!)) throw new Error(`Unknown strategy: ${args.strategy}`)
const batchSize = Number(args['batch-size'])
if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('batch-size must be 1..100')
const out = resolve(args.out)
await mkdir(out, { recursive: true })
const inputBytes = await readFile(resolve(args.input))
const inputSha256 = createHash('sha256').update(inputBytes).digest('hex')
const document = decodeParsedDocument(JSON.parse(inputBytes.toString()))
const source = sourceContext(document)
const entries = canonicalAnchorInventory(document)
const labelByAnchor = new Map([...source.anchorIdByLabel].map(([label, id]) => [id, label]))
const sourceHash = document.document.content_sha256
const codeHashes = Object.fromEntries(await Promise.all(['run.ts', 'schema.ts', 'link.ts', 'examples.ts'].map(async file => [file,
  createHash('sha256').update(await readFile(fileURLToPath(new URL(file, import.meta.url)))).digest('hex'),
])))
const experiment = { ...args, inputSha256, sourceHash, schemaDefinition, codeHashes, startedAt: new Date().toISOString() }
await writeFile(join(out, 'manifest.json'), JSON.stringify(experiment, null, 2), { flag: 'wx' })

type Row = { values: Record<string, unknown>; evidence: Record<string, string[]>; issues: string[] }
type Call = { index: number; phase: string; model: string; durationMs: number; status: string; metadata?: unknown; providerInvocations: number; error?: string }
const calls: Call[] = []
const targets = new Map<string, ExecutionTarget>()
let reusedDiscovery: unknown = null
let boundaries: readonly CatalogBoundary[] = []
let rows: Row[] = []
let failure: string | null = null
let finished = false
const started = performance.now()

async function targetFor(name: string): Promise<ExecutionTarget> {
  if (targets.has(name)) return targets.get(name)!
  let target: ExecutionTarget
  if (name === 'nuextract') {
    target = { profile: 'nuextract-raw', modelId: 'hf.co/numind/NuExtract3-GGUF:Q4_K_M',
      baseUrl: args['ollama-url']!, authorization: null, temperatureSupported: true,
      attribution: { provider: 'ollama', modelId: 'hf.co/numind/NuExtract3-GGUF:Q4_K_M' } }
  } else if (name === 'luna') {
    const config = await readModelConfig()
    const connection = config.connections.find(c => c.provider === 'codex-cli')
    if (!connection) throw new Error('Existing Codex CLI Model Connection required for Luna baseline')
    target = await resolveCapabilityRoute('extraction', {}, { config: {
      ...config, routes: { ...config.routes, extraction: { connectionId: connection.id, modelId: 'gpt-5.6-luna' } },
    } })
  } else throw new Error(`Unknown model ${name}; use luna or nuextract`)
  targets.set(name, target)
  return target
}

async function invoke(name: string, phase: string, input: Omit<ExtractModelInput, 'signal'>) {
  const index = calls.length + 1
  const prefix = join(out, `call-${String(index).padStart(3, '0')}`)
  const target = await targetFor(name)
  const request = { ...input, outputSchema: input.outputSchema ? z.toJSONSchema(input.outputSchema) : null }
  await writeFile(`${prefix}-request.json`, JSON.stringify({ name, phase, request }, null, 2))
  clearInspector()
  const begin = performance.now()
  const call: Call = { index, phase, model: name, durationMs: 0, status: 'failed', providerInvocations: 0 }
  calls.push(call)
  console.log(`START ${index} ${phase} ${name}`)
  try {
    const response = await extractWithModel({ ...input, signal: AbortSignal.timeout(Number(args.timeout)) }, target,
      args['few-shot'] && name === 'nuextract' ? { fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body))
        body.prompt = body.prompt.replace('【document_start】', exampleBlock(input.template as Record<string, unknown>) + '【document_start】')
        // The app trace precedes this prototype-only transport adjustment; preserve actual bytes too.
        await writeFile(`${prefix}-actual-ollama-request.json`, JSON.stringify(body, null, 2))
        return fetch(url, { ...init, body: JSON.stringify(body) })
      } } : {})
    call.status = 'succeeded'
    call.metadata = response.metadata
    await writeFile(`${prefix}-response.json`, JSON.stringify(response, null, 2))
    return response
  } catch (error) {
    call.error = error instanceof Error ? error.message : String(error)
    await writeFile(`${prefix}-error.json`, JSON.stringify({ error: call.error }, null, 2))
    throw error
  } finally {
    call.durationMs = Math.round(performance.now() - begin)
    const traces = await inspectorResponse().json()
    call.providerInvocations = traces.traces.length
    await writeFile(`${prefix}-transport.json`, JSON.stringify(traces, null, 2))
    await writeFile(join(out, 'calls.json'), JSON.stringify(calls, null, 2))
    console.log(`END ${index} ${call.status} ${call.durationMs}ms`)
  }
}

function input(markdown: string, template: Record<string, unknown>, instruction: string): Omit<ExtractModelInput, 'signal'> {
  return { document: { file: null, markdown, pages: document.page_count }, template, instruction }
}

// Deliberately the current Studio grounding prompt, retained for the exact baseline.
const groundingLead = 'Ground every claim listed after "### Claims". Return exactly the keys shown under "links". Each value must be one exact E label from "### Canonical Evidence", without brackets, or NONE when no candidate directly supports the claim. A translated or normalized claim may cite a passage expressing the same meaning. A claim value or source passage is never a link: do not copy either into the links map. Never cite a C label. Add no snippets, pages, coordinates, explanations, or extra keys.'
function baselineGrounder(name: string): GroundingModel {
  return { async ground(request) {
    const generated = await invoke(name, 'grounding', input(
      ['### Canonical Evidence', ...Object.entries(request.anchors).map(([l, t]) => `[${l}] ${t}`)].join('\n'),
      { links: Object.fromEntries(Object.keys(request.claims).map(c => [c, 'verbatim-string'])) },
      [groundingLead, '', '### Claims', ...Object.entries(request.claims).map(([l, v]) => `[${l}] ${JSON.stringify(v)}`)].join('\n'),
    ))
    const result = generated.result
    if (Object.keys(result).length !== 1 || !result.links || typeof result.links !== 'object' || Array.isArray(result.links)) throw new Error('Invalid grounding envelope')
    const selections = Object.entries(result.links).map(([claimLabel, label]) => {
      if (typeof label !== 'string' || !label) throw new Error('Invalid grounding selection')
      return { claimLabel, anchorLabel: label === 'NONE' ? null : label }
    })
    return { selections, metadata: generated.metadata }
  } }
}

async function baseline() {
  const target = await targetFor(args.model!)
  const execute = createExtractionJobExecutor({
    inputs: {
      async loadExtractionInputs() { return { sourceDocumentId: 'prototype-source', projectContextId: 'prototype', sourceRepresentationRevisionId: 'prototype-source-revision', schemaRevisionId: 'prototype-schema', schemaTree: schemaDefinition, parsedDocument: document } },
      async readExtractionAttempt() { return null },
    },
    models: { async open() { return {
      attribution: target.attribution!,
      model: { async extract(request: ExtractionModelRequest) {
        const response = await invoke(args.model!, 'starts' in request.template ? 'discovery' : 'extraction', {
          ...input(request.document.markdown, { ...request.template }, request.instruction ?? ''), outputSchema: request.outputSchema,
        })
        return { result: response.result, metadata: response.metadata }
      } },
      groundingModel: baselineGrounder(args['ground-model'] ?? args.model!),
    } } },
  })
  const terminal = await execute({ kind: 'fresh', extractionId: 'prototype-run', sourceRepresentationRevisionId: 'prototype-source-revision', schemaRevisionId: 'prototype-schema', strategy: 'CATALOG' }, null,
    async checkpoint => { await writeFile(join(out, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2)) }, new AbortController().signal)
  await writeFile(join(out, 'terminal.json'), JSON.stringify(terminal, null, 2))
  boundaries = terminal.diagnostics.catalog?.records.filter(r => r.outcome === 'succeeded').map(r => r.boundary) ?? []
  rows = (terminal.result?.records as Record<string, unknown>[] ?? []).map((values, index) => ({ values,
    evidence: Object.fromEntries(fields.map(field => [field, (terminal.evidence ?? []).filter(e => e.resultPath[1] === index && e.resultPath[2] === field).map(e => e.evidenceAnchorId)])), issues: [],
  }))
}

function inventoryFor(boundary: Pick<CatalogBoundary, 'startContentIndex' | 'endContentIndex'>) {
  const blocks = document.content_stream.slice(boundary.startContentIndex, boundary.endContentIndex)
  const blockIds = new Set(blocks.map(b => b.block_id))
  const tableIds = new Set(blocks.flatMap(b => b.kind === 'table' ? [b.table_id] : []))
  const ids = new Set(document.evidence_index.anchors.filter(a => a.kind === 'text' ? blockIds.has(a.block_id) : tableIds.has(a.logical_table_id)).map(a => a.anchor_id))
  return entries.filter(e => ids.has(e.anchorId))
}
function labelledSource(boundary: Pick<CatalogBoundary, 'startContentIndex' | 'endContentIndex'>) {
  return inventoryFor(boundary).map(e => `[${labelByAnchor.get(e.anchorId)}] ${e.text}`).join('\n')
}
function rowFromJoint(record: Record<string, unknown>, allowed: ReadonlySet<string>): Row {
  const evidence: Record<string, string[]> = {}
  const issues: string[] = []
  for (const field of fields) {
    const label = (record.evidence as Record<string, unknown> | undefined)?.[field]
    const anchor = typeof label === 'string' ? source.anchorIdByLabel.get(label) : undefined
    evidence[field] = anchor && allowed.has(anchor) ? [anchor] : []
    if (label != null && label !== 'NONE' && !evidence[field].length) issues.push(`invalid-evidence:${field}:${JSON.stringify(label)}`)
  }
  return { values: Object.fromEntries(fields.map(f => [f, record[f] ?? null])), evidence, issues }
}
function recordsFrom(result: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(result.records) || result.records.some(r => !r || typeof r !== 'object' || Array.isArray(r))) throw new Error('Invalid records envelope')
  return result.records as Record<string, unknown>[]
}

function lexicalRow(record: Record<string, unknown>, boundary: CatalogBoundary | undefined): Row {
  const row: Row = { values: Object.fromEntries(fields.map(f => [f, record[f] ?? null])), evidence: {}, issues: [] }
  const candidates = boundary ? inventoryFor(boundary) : []
  for (const field of fields) {
    const value = row.values[field]
    const hits = lexicalCandidates(field, value, candidates, args['field-aware']!)
    // Abstain on every ambiguity. An existing valid label is not proof of field support.
    row.evidence[field] = hits.length === 1 ? [hits[0].anchorId] : []
    if (value != null && hits.length !== 1) row.issues.push(`lexical-${hits.length ? 'ambiguous' : 'missing'}:${field}`)
  }
  return row
}

async function loadBoundaries() {
  if (args.strategy === 'rule-grouped-lexical') {
    // Explicit Beier-format hypothesis: numbered opening plus the printed Fdpl. label.
    // No gold IDs or reference values are consulted by any execution strategy.
    const starts = document.content_stream.filter(b => 'text' in b && /^\s*\d+\.\s+\p{L}/u.test(b.text) && /\bFdpl\./.test(b.text)).map(b => b.block_id)
    boundaries = resolveCatalogBoundaries(document, starts)
    return
  }
  if (!args['discovery-from']) throw new Error('This strategy needs --discovery-from baseline result.json')
  const previous = JSON.parse(await readFile(resolve(args['discovery-from']), 'utf8'))
  if (previous.inputSha256 !== inputSha256) throw new Error('Discovery input hash mismatch')
  if (!previous.boundaries?.length) throw new Error('Baseline supplied no boundaries')
  boundaries = previous.boundaries
  reusedDiscovery = { source: resolve(args['discovery-from']), calls: previous.calls.filter((c: Call) => c.phase === 'discovery') }
}

async function byRecords() {
  await loadBoundaries()
  const selected = args['development-only'] ? boundaries.filter(b => document.content_stream[b.startContentIndex].page_number === 1) : boundaries
  const separate = args.strategy === 'separate'
  const size = args.strategy === 'joint' || separate ? 1 : batchSize
  for (let start = 0; start < selected.length; start += size) {
    const group = selected.slice(start, start + size)
    const lexical = args.strategy!.includes('lexical')
    const valuesOnly = lexical || separate
    const text = group.map((b, i) => `### Source record ${i + 1}\n${valuesOnly ? canonicalSourceSlice(document, b.startContentIndex, b.endContentIndex) : labelledSource(b)}`).join('\n\n')
    const response = await invoke(args.model!, valuesOnly ? 'grouped-values' : 'joint-extraction-evidence', input(text,
      { records: [valuesOnly ? valueTemplate : jointTemplate] },
      `${valuesOnly ? recordDescription : jointInstruction}\nReturn exactly one record for each of the ${group.length} source records, in source order.`,
    ))
    const allowed = new Set(group.flatMap(b => inventoryFor(b).map(e => e.anchorId)))
    const boundaryByNumber = new Map(group.map(b => {
      const block = document.content_stream[b.startContentIndex]
      return [Number(/^\s*(\d+)\./.exec('text' in block ? block.text : '')?.[1]), b]
    }))
    for (const record of recordsFrom(response.result)) rows.push(separate
      ? { values: Object.fromEntries(fields.map(f => [f, record[f] ?? null])), evidence: {}, issues: [] }
      : lexical
      ? lexicalRow(record, boundaryByNumber.get(Number(record.catalog_number)))
      : rowFromJoint(record, allowed))
    await saveProgress()
  }
  if (separate) {
    const byNumber = boundaryIndex(selected)
    const rowBoundaries = rows.map(r => byNumber.get(Number(r.values.catalog_number)))
    if (rowBoundaries.some(b => !b)) throw new Error('Separate grounder received unknown record identities')
    const grounded = await groundExtraction(document, { records: rows.map(r => r.values) }, baselineGrounder(args['ground-model'] ?? args.model!), new AbortController().signal,
      { recordBoundaries: rowBoundaries as CatalogBoundary[] })
    rows.forEach((row, i) => { row.evidence = Object.fromEntries(fields.map(f => [f, grounded.evidence.filter(e => e.resultPath[1] === i && e.resultPath[2] === f).map(e => e.evidenceAnchorId)])) })
    await writeFile(join(out, 'grounding.json'), JSON.stringify(grounded, null, 2))
  }
  if (args['fallback-model'] && args.strategy!.includes('lexical')) await selectiveFallback(selected)
}

function boundaryIndex(selected: readonly CatalogBoundary[]) {
  return new Map(selected.map(b => {
    const block = document.content_stream[b.startContentIndex]
    return [Number(/^\s*(\d+)\./.exec('text' in block ? block.text : '')?.[1]), b]
  }))
}

async function selectiveFallback(selected: readonly CatalogBoundary[]) {
  const index = boundaryIndex(selected)
  const claims: { label: string; field: typeof fields[number]; row: Row; allowed: Set<string> }[] = []
  const texts: string[] = []
  for (const row of rows) {
    const unresolved = fields.filter(f => row.values[f] != null && row.values[f] !== '' && !row.evidence[f]?.length)
    if (!unresolved.length) continue
    const boundary = index.get(Number(row.values.catalog_number))
    if (!boundary) continue
    const allowed = new Set(inventoryFor(boundary).map(e => e.anchorId))
    texts.push(`### Catalog record ${row.values.catalog_number}\n${labelledSource(boundary)}\nClaims for this record:`)
    for (const field of unresolved) {
      const label = `C${claims.length + 1}`
      claims.push({ label, field, row, allowed })
      texts.push(`[${label}] field=${field}; value=${JSON.stringify(row.values[field])}`)
    }
  }
  if (!claims.length) return
  const response = await invoke(args['fallback-model']!, 'selective-grounding', input(texts.join('\n'),
    { links: Object.fromEntries(claims.map(c => [c.label, 'verbatim-string'])) },
    `${recordDescription}\nSelect evidence ONLY for the listed claims. Return links from C labels to one exact E label, or NONE if no passage directly supports the field value. Each claim must use evidence from its OWN catalog record. Field definitions matter: a matching value in an unrelated detail is insufficient. Do not change values or add claims.`,
  ))
  const links = response.result.links as Record<string, unknown> | undefined
  for (const claim of claims) {
    const label = links?.[claim.label]
    const anchor = typeof label === 'string' ? source.anchorIdByLabel.get(label) : undefined
    if (anchor && claim.allowed.has(anchor)) claim.row.evidence[claim.field] = [anchor]
    else if (label != null && label !== 'NONE') claim.row.issues.push(`invalid-fallback:${claim.field}`)
  }
}

async function byChunks() {
  for (const chunk of catalogDiscoveryChunks(document)) {
    const selectedIds = new Set(chunk.startBlockIdByLabel.values())
    const indexes = document.content_stream.flatMap((b, i) => selectedIds.has(b.block_id) ? [i] : [])
    if (!indexes.length) continue
    const first = Math.min(...indexes), last = Math.max(...indexes) + 1
    if (args['development-only'] && document.content_stream[first].page_number !== 1) continue
    const main = { startContentIndex: first, endContentIndex: last }
    const before = { startContentIndex: Math.max(0, first - 3), endContentIndex: first }
    const after = { startContentIndex: last, endContentIndex: Math.min(document.content_stream.length, last + 3) }
    const text = `PREVIOUS CONTEXT: continuation only; do not start a record here.\n${labelledSource(before)}\n\nSELECTABLE RECORD STARTS:\n${labelledSource(main)}\n\nFOLLOWING CONTEXT: may complete a record; do not start a record here.\n${labelledSource(after)}`
    const response = await invoke(args.model!, 'chunk-discovery-extraction-evidence', input(text,
      { records: [{ ...jointTemplate, start_anchor: 'verbatim-string' }] },
      `${jointInstruction}\nReturn ALL parent records whose opening block occurs in SELECTABLE RECORD STARTS, even short entries. start_anchor must be the exact E label of each record's opening block. Use following context to complete fields if necessary. Do not create new records from previous or following context.`,
    ))
    const allowed = new Set([...inventoryFor(before), ...inventoryFor(main), ...inventoryFor(after)].map(e => e.anchorId))
    const selectable = new Set(inventoryFor(main).map(e => e.anchorId))
    for (const record of recordsFrom(response.result)) {
      const row = rowFromJoint(record, allowed)
      const anchor = source.anchorIdByLabel.get(String(record.start_anchor))
      if (!anchor || !selectable.has(anchor)) row.issues.push('invalid-start-anchor')
      rows.push(row) // Preserve bad/duplicate rows for scoring; never silently fix model recall.
    }
    await saveProgress()
  }
}

async function saveProgress() {
  await writeFile(join(out, 'result.json'), JSON.stringify({
    ...experiment, durationMs: Math.round(performance.now() - started), completedAt: finished ? new Date().toISOString() : null,
    executionStatus: finished ? failure ? 'failed' : 'complete' : 'running',
    calls, reusedDiscovery, boundaries, rows, failure,
  }, null, 2))
}
try {
  if (args.strategy === 'baseline') await baseline()
  else if (args.strategy === 'chunk-joint') await byChunks()
  else await byRecords()
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
  console.error(failure)
  process.exitCode = 1
} finally {
  finished = true
  await saveProgress()
  await closeProviderRuntime()
}
