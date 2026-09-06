// Lab-only paired extraction. No labels are read and no production grounding runs.
// tsx scripts/quote-extraction.mts --source DIR --output DIR --arm baseline|quote
//   [--context 262144] [--output-tokens 32768] [--prepare-only]
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { decodeParsedDocument, type ParsedDocument } from 'extraction/parsed-document'
import { canonicalSource } from 'extraction/source-context'

export const MODEL = 'qwen3.8:27b'
export const MODEL_DIGEST = '22130167c4c20e20c7b71454612966ca8e8171e9b3cc8ab6ce8aa6cbfec79643'
export const INSTRUCTION = 'Extract document metadata and the first 20 eligible burial records in source reading order. Eligible records are definite, explicitly identified graves or burials. Exclude probable or conjectured graves (including EvG, vG, and "vermutlich Grab"), explicitly rejected burial interpretations, settlements, stray finds, bibliographic references, and unrelated find records. If fewer than 20 exist, return all eligible records. Use only explicitly stated information, preserve identifiers and suffixes, and never infer or compute values. Respect source legends for measurement units, emit each measurement in its declared unit using the schema value and unit fields, and perform no unit conversions. Return null for missing scalar information and [] for empty collections. Return exactly the schema keys and JSON types, without explanations.'
export const QUOTE_INSTRUCTION = 'For every scalar leaf, emit {"value": the typed scalar or null, "evidenceQuote": one contiguous verbatim source quote or null}. Quotes must include enough local context to support the field and record. Copy characters, punctuation, numeric suffixes, and units exactly; whitespace may differ. Do not splice passages or invent text. Use null when no quote is available. Keep the original array and object structure.'
type Template = string | { [key: string]: Template } | Template[]
type Path = (string | number)[]
export type QuoteLeaf = { resultPath: Path; value: unknown; evidenceQuote: string | null }
export type SourceSpan = { anchorId: string; start: number; end: number }
export type MappedSource = { text: string; spans: SourceSpan[] }
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
export const sha256 = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex')

/** Preserve decimal example types before JSON.parse folds 0.0 into an integer.
 * Quoted strings are matched first, so numeric characters inside them stay intact. */
export function templateFromSchema(text: string): Record<string, Template> {
  const parsed: unknown = JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false)\b/g,
    (token) => token.startsWith('"') ? token : JSON.stringify(token === 'true' || token === 'false' ? 'boolean' : /[.eE]/.test(token) ? 'number' : 'integer')))
  const convert = (node: unknown): Template => {
    if (Array.isArray(node)) {
      if (node.length !== 1) throw new Error('Schema arrays need exactly one item template')
      return [convert(node[0])]
    }
    if (record(node)) return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, convert(value)]))
    if (typeof node === 'string' && /^(string|number|integer|boolean|date)$/.test(node)) return node
    if (typeof node === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(node)) return 'date'
    throw new Error(`Unsupported schema leaf: ${JSON.stringify(node)}`)
  }
  if (!record(parsed)) throw new Error('Schema root must be an object')
  return convert(parsed) as Record<string, Template>
}

export function wrapTemplate(template: Template): Template {
  if (typeof template === 'string') return { value: template, evidenceQuote: 'string' }
  if (Array.isArray(template)) return [wrapTemplate(template[0])]
  return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, wrapTemplate(value)]))
}

export function jsonSchema(template: Template): Record<string, unknown> {
  if (typeof template === 'string') return template === 'date'
    ? { type: ['string', 'null'], format: 'date' } : { type: [template, 'null'] }
  if (Array.isArray(template)) return { type: 'array', items: jsonSchema(template[0]) }
  return { type: 'object', properties: Object.fromEntries(Object.entries(template).map(([key, value]) => [key, jsonSchema(value)])), required: Object.keys(template), additionalProperties: false }
}

export function validateTyped(value: unknown, template: Template, path: Path = []): void {
  const fail = () => { throw new Error(`Invalid typed result at ${JSON.stringify(path)}: expected ${JSON.stringify(template)}`) }
  if (typeof template === 'string') {
    if (value === null) return
    if (template === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value)
      : template === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : template === 'date' ? typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
      : typeof value === template) return
    return fail()
  }
  if (Array.isArray(template)) {
    if (!Array.isArray(value)) return fail()
    value.forEach((item, index) => validateTyped(item, template[0], [...path, index]))
    return
  }
  if (!record(value) || Object.keys(value).length !== Object.keys(template).length || Object.keys(template).some((key) => !Object.hasOwn(value, key))) return fail()
  for (const [key, child] of Object.entries(template)) validateTyped(value[key], child, [...path, key])
}

export function unwrapQuotes(value: unknown, template: Template): { result: unknown; quotes: QuoteLeaf[] } {
  validateTyped(value, wrapTemplate(template))
  const quotes: QuoteLeaf[] = []
  const walk = (current: any, node: Template, path: Path): unknown => {
    if (typeof node === 'string') {
      quotes.push({ resultPath: path, value: current.value, evidenceQuote: current.evidenceQuote })
      return current.value
    }
    if (Array.isArray(node)) return current.map((item: unknown, index: number) => walk(item, node[0], [...path, index]))
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(current[key], child, [...path, key])]))
  }
  return { result: walk(value, template, []), quotes }
}

/** Mirror the canonical renderer only to record offsets, then assert byte-for-byte
 * identity. Searching an anchor-text concatenation would fabricate occurrences. */
export function mappedCanonicalSource(document: ParsedDocument): MappedSource {
  let text = ''
  const spans: SourceSpan[] = []
  const anchorByBlock = new Map(document.evidence_index.anchors.flatMap((anchor) => anchor.kind === 'text' ? [[anchor.block_id, anchor.anchor_id] as const] : []))
  const blocks = new Map(document.content_stream.map((block) => [block.block_id, block]))
  const tables = new Map(document.tables.map((table) => [table.table_id, table]))
  const seen = new Set<string>()
  const append = (value: string, anchorId?: string, separator = '\n') => {
    if (text) text += separator
    const start = text.length
    text += value
    if (anchorId && value.length) spans.push({ anchorId, start, end: text.length })
  }
  const table = (id: string) => {
    const current = tables.get(id)
    if (!current || seen.has(id)) return
    seen.add(id)
    if (!current.cells.length) return
    append(`### Table ${id}`)
    let row: number | null = null
    for (const cell of [...current.cells].sort((a, b) => a.row - b.row || a.column - b.column)) {
      append(cell.text, cell.evidence_anchor_id, row === cell.row ? ' | ' : '\n')
      row = cell.row
    }
  }
  for (const page of document.pages) {
    append(`## Page ${page.page_number}`)
    for (const id of page.ordered_content) {
      const block = blocks.get(id)
      if (!block) continue
      if (block.kind === 'table') { table(block.table_id); continue }
      const value = 'text' in block ? block.text : block.kind === 'list' ? block.items.join('; ') : ''
      if (value.trim()) append(value, anchorByBlock.get(id))
    }
    for (const id of page.unplaced_content) table(id)
  }
  if (text !== canonicalSource(document)) throw new Error('Canonical source offset renderer differs from canonicalSource')
  return { text, spans }
}

function normalizedWithOffsets(text: string): { text: string; starts: number[]; ends: number[] } {
  let normalized = ''
  const starts: number[] = [], ends: number[] = []
  for (const match of text.matchAll(/\s+|\S/gu)) {
    const value = /^\s/u.test(match[0]) ? ' ' : match[0]
    normalized += value
    // Offsets are JavaScript UTF-16 positions, including both halves of astral characters.
    for (let i = 0; i < value.length; i++) { starts.push(match.index); ends.push(match.index + match[0].length) }
  }
  return { text: normalized, starts, ends }
}

export function mapQuotes(source: MappedSource, quotes: QuoteLeaf[]) {
  const normalized = normalizedWithOffsets(source.text)
  return quotes.map((leaf) => {
    const needle = leaf.evidenceQuote?.replace(/\s+/gu, ' ').trim() ?? ''
    const occurrences: { start: number; end: number; anchorIds: string[]; fullyMapped: boolean }[] = []
    if (needle) for (let position = normalized.text.indexOf(needle); position !== -1; position = normalized.text.indexOf(needle, position + 1)) {
      const start = normalized.starts[position], end = normalized.ends[position + needle.length - 1]
      const spans = source.spans.filter((span) => span.start < end && span.end > start)
      // Synthetic page/table labels are not evidence. Canonical table separators
      // and whitespace between adjacent anchors are allowed inside a quoted span.
      let cursor = start, fullyMapped = spans.length > 0
      for (const span of spans) {
        if (span.start > cursor && !/^[\s|]*$/u.test(source.text.slice(cursor, span.start))) fullyMapped = false
        cursor = Math.max(cursor, span.end)
      }
      if (cursor < end && !/^[\s|]*$/u.test(source.text.slice(cursor, end))) fullyMapped = false
      occurrences.push({ start, end, anchorIds: [...new Set(spans.map((span) => span.anchorId))], fullyMapped })
    }
    const mapped = occurrences.filter((item) => item.fullyMapped)
    return { ...leaf, quoteValid: occurrences.length > 0, status: !needle ? 'missing' : !occurrences.length ? 'not_found'
      : mapped.length !== occurrences.length ? 'mapping_failure' : mapped.length > 1 ? 'ambiguous' : 'mapped', occurrences,
    proposedAnchorSets: mapped.map((item) => item.anchorIds), offsetUnit: 'utf16' }
  })
}

export function validateCompletion(response: any, outputTokens: number): void {
  if (response.done !== true || response.done_reason !== 'stop') throw new Error(`Incomplete generation: ${String(response.done_reason)}`)
  if (!Number.isInteger(response.prompt_eval_count) || response.prompt_eval_count <= 0 || !Number.isInteger(response.eval_count) || response.eval_count <= 0) throw new Error('Missing token usage')
  if (response.eval_count >= outputTokens) throw new Error('Generation reached output budget')
}

// Native HTTP lets long full-document requests set their actual deadline;
// Node fetch otherwise times out waiting for headers after five minutes.
export function postJson(url: string, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolveRequest, reject) => {
    const request = (url.startsWith('https:') ? httpsRequest : httpRequest)(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('error', reject)
      response.on('end', () => resolveRequest({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.setTimeout(7200000, () => request.destroy(new Error('Ollama extraction exceeded two-hour timeout')))
    request.end(JSON.stringify(body))
  })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const option = (key: string, fallback?: string) => { const i = args.indexOf(key); return i === -1 ? fallback : args[i + 1] }
  const sourceDir = option('--source'), outputDir = option('--output'), arm = option('--arm')
  if (!sourceDir || !outputDir || (arm !== 'baseline' && arm !== 'quote')) throw new Error('Required: --source DIR --output DIR --arm baseline|quote')
  if (resolve(sourceDir) === resolve(outputDir)) throw new Error('Output directory must differ from source directory')
  const context = Number(option('--context', '262144')), outputTokens = Number(option('--output-tokens', '32768'))
  if (!Number.isSafeInteger(context) || !Number.isSafeInteger(outputTokens) || outputTokens < 1 || context <= outputTokens) throw new Error('Invalid context/output budgets')
  mkdirSync(outputDir, { recursive: true })
  if (existsSync(join(outputDir, 'extracted_meta.json'))) throw new Error('Existing attempt: choose a new output directory')
  const save = (name: string, value: unknown) => writeFileSync(join(outputDir, name), JSON.stringify(value, null, 2) + '\n')
  const started = Date.now()
  const meta: Record<string, any> = { arm, startedAt: new Date(started).toISOString(), model: MODEL, modelDigest: MODEL_DIGEST, provider: 'ollama', baseUrl: process.env.FREE_LIVE_OLLAMA_URL ?? 'http://spark.cdch-dgxspark.lan.ku.dk:11434', context, outputTokens, temperature: 0, think: false, sourceDirectory: resolve(sourceDir), documentSource: 'canonicalSource', windowed: null, modelCalls: 0, error: null, complete: false }
  try {
    const parsedBytes = readFileSync(join(sourceDir, 'parsed_document.json'))
    const document = decodeParsedDocument(JSON.parse(parsedBytes.toString('utf8')))
    const source = mappedCanonicalSource(document)
    const schemaBytes = readFileSync(join(sourceDir, 'schema.json'), 'utf8')
    const template = templateFromSchema(schemaBytes)
    const usedTemplate = arm === 'quote' ? wrapTemplate(template) : template
    const instructionPath = join(sourceDir, 'instruction.txt')
    const instruction = existsSync(instructionPath) ? readFileSync(instructionPath, 'utf8') : ''
    const prompt = `${INSTRUCTION}${instruction ? '\n\nSource-specific instructions:\n' + instruction : ''}${arm === 'quote' ? '\n' + QUOTE_INSTRUCTION : ''}\n\nSchema (scalar type names):\n${JSON.stringify(usedTemplate)}\n\nSource:\n${source.text}`
    const request = { model: MODEL, messages: [{ role: 'user', content: prompt }], format: jsonSchema(usedTemplate), stream: false, think: false, truncate: false, shift: false, options: { temperature: 0, num_ctx: context, num_predict: outputTokens, seed: 0 } }
    Object.assign(meta, { sourcePdfSha256: document.document.content_sha256, parsedSha256: sha256(parsedBytes), schemaSha256: sha256(schemaBytes), instructionSha256: sha256(instruction), sourceSha256: sha256(source.text), promptSha256: sha256(prompt), requestSha256: sha256(JSON.stringify(request)), markdownChars: source.text.length })
    save('request.json', request)
    save('template.json', template)
    save('source_spans.json', source.spans)
    writeFileSync(join(outputDir, 'canonical_source.txt'), source.text)
    save('prepared.json', meta)
    if (args.includes('--prepare-only')) return
    // Verified in v0.32.14 api/types.go and server/routes.go: truncate:false
    // retains the full prompt and shift:false prevents generation dropping it.
    const versionResponse = await fetch(`${meta.baseUrl}/api/version`, { signal: AbortSignal.timeout(30000) })
    if (!versionResponse.ok) throw new Error(`Ollama version HTTP ${versionResponse.status}`)
    const version: any = await versionResponse.json()
    meta.ollamaVersion = version.version
    if (version.version !== '0.32.14') throw new Error(`Unverified Ollama version ${version.version}; verify truncate/shift controls before running`)
    const tagsResponse = await fetch(`${meta.baseUrl}/api/tags`, { signal: AbortSignal.timeout(30000) })
    if (!tagsResponse.ok) throw new Error(`Ollama tags HTTP ${tagsResponse.status}`)
    const tags: any = await tagsResponse.json()
    if (!tags.models?.some((entry: any) => entry.name === MODEL && entry.digest.replace(/^sha256:/, '') === MODEL_DIGEST)) throw new Error('Pinned model digest is unavailable or changed')
    meta.modelCalls = 1
    const response = await postJson(`${meta.baseUrl}/api/chat`, request)
    const raw = response.text
    writeFileSync(join(outputDir, 'transport_raw.json'), raw)
    if (response.status < 200 || response.status >= 300) throw new Error(`Ollama chat HTTP ${response.status}: ${raw.slice(0, 500)}`)
    const body = JSON.parse(raw)
    meta.metadata = { finishReason: body.done_reason, promptTokens: body.prompt_eval_count, outputTokens: body.eval_count, totalDurationNs: body.total_duration, loadDurationNs: body.load_duration, promptEvalDurationNs: body.prompt_eval_duration, evalDurationNs: body.eval_duration }
    validateCompletion(body, outputTokens)
    if (body.prompt_eval_count + body.eval_count > context) throw new Error('Reported token usage exceeds configured context')
    const value = JSON.parse(body.message.content)
    validateTyped(value, usedTemplate)
    const unwrapped = arm === 'quote' ? unwrapQuotes(value, template) : { result: value, quotes: [] }
    if (record(unwrapped.result) && Array.isArray(unwrapped.result.records) && unwrapped.result.records.length > 20) throw new Error('Result exceeds 20 burial records')
    if (arm === 'quote') { save('extracted_wrapped.json', value); save('quote_mappings.json', mapQuotes(source, unwrapped.quotes)) }
    save('extracted_raw.json', unwrapped.result)
    meta.complete = true
  } catch (error) {
    meta.error = String(error)
    if (error instanceof Error && error.cause) meta.errorCause = String(error.cause)
    process.exitCode = 1
    process.stderr.write(`${meta.error}\n`)
  } finally {
    if (!args.includes('--prepare-only') || meta.error) {
      meta.elapsedSeconds = (Date.now() - started) / 1000
      meta.finishedAt = new Date().toISOString()
      save('extracted_meta.json', meta)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
