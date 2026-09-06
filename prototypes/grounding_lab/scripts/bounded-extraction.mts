// Lab-only development experiment. Reuse frozen quote and canonical-source helpers.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { decodeParsedDocument } from 'extraction/parsed-document'
import { canonicalSourceSlice } from 'extraction/source-context'
import { MODEL, MODEL_DIGEST, INSTRUCTION, QUOTE_INSTRUCTION, templateFromSchema, jsonSchema, wrapTemplate, validateTyped, unwrapQuotes, mappedCanonicalSource, mapQuotes, validateCompletion, postJson, sha256 } from './quote-extraction.mts'

export type RecordRequest = { sourceKey: string; start: number; end: number; identityBlock: number; identityQuote: string; contextBlocks: number[] }
export function validateDiscovery(records: Omit<RecordRequest, 'sourceKey'>[], blocks: string[]): RecordRequest[] {
  if (!records.length || records.length > 20) throw new Error('Discovery must identify 1–20 records')
  const seen = new Set<string>()
  return records.map((record, i) => {
    if (!Number.isSafeInteger(record.start) || !Number.isSafeInteger(record.end) || record.start < 0 || record.end <= record.start || record.end > blocks.length || (i > 0 && record.start < records[i - 1].start)) throw new Error('Invalid or unordered complete region')
    if (!Number.isSafeInteger(record.identityBlock) || record.identityBlock < record.start || record.identityBlock >= record.end || (i > 0 && record.identityBlock < records[i - 1].identityBlock)) throw new Error('Invalid or unordered record identity block')
    if (!Array.isArray(record.contextBlocks) || record.contextBlocks.some(b => !Number.isSafeInteger(b) || b < 0 || b >= blocks.length) || new Set(record.contextBlocks).size !== record.contextBlocks.length) throw new Error('Invalid shared source context blocks')
    const text = blocks[record.identityBlock].replace(/\s+/g, ' ')
    if (typeof record.identityQuote !== 'string' || !record.identityQuote.trim() || !text.includes(record.identityQuote.replace(/\s+/g, ' '))) throw new Error('Record identity must occur verbatim inside its region')
    const key = JSON.stringify([record.identityBlock, record.identityQuote.replace(/\s+/g, ' ')])
    if (seen.has(key)) throw new Error('Duplicate discovered record')
    seen.add(key)
    return { ...record, sourceKey: `R${String(i + 1).padStart(3, '0')}` }
  })
}

export function validateBatch(rows: { sourceKey: string; record: unknown }[], requested: RecordRequest[]): void {
  if (rows.length !== requested.length || rows.some((row, i) => row.sourceKey !== requested[i].sourceKey)) throw new Error('Missing, duplicate, extra, or reordered requested record ID')
}

async function main() {
  const args = process.argv.slice(2)
  const option = (key: string, fallback?: string) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1] }
  const source = resolve(option('--source') ?? ''), output = resolve(option('--output') ?? '')
  if (!option('--source') || !option('--output') || source === output || existsSync(output)) throw new Error('Supply a source and a new output directory')
  mkdirSync(output, { recursive: true })
  const started = performance.now()
  const save = (name: string, value: unknown) => writeFileSync(join(output, name), JSON.stringify(value, null, 2))
  const meta: any = { startedAt: new Date().toISOString(), source, model: MODEL, modelDigest: MODEL_DIGEST, context: 262144, outputTokens: 8192, batchSize: 2, retries: 0, complete: false, calls: [], arms: {}, autoAccept: false }
  try {
    const bytes = readFileSync(join(source, 'parsed_document.json'))
    const document = decodeParsedDocument(JSON.parse(bytes.toString()))
    const schemaBytes = readFileSync(join(source, 'schema.json'))
    const template = templateFromSchema(schemaBytes.toString())
    if (!Array.isArray(template.records) || typeof template.records[0] !== 'object') throw new Error('Expected records array schema')
    const { records: recordTemplates, ...metadataTemplate } = template
    const recordTemplate = recordTemplates[0]
    const canonical = mappedCanonicalSource(document)
    const blocks = document.content_stream.map((_, i) => canonicalSourceSlice(document, i, i + 1))
    // ponytail: discovery is one full-source call; reject context overflow rather than silently windowing.
    const discoverySource = blocks.map((text, i) => `[[block:${i}]]\n${text}`).join('\n')
    meta.sourceHash = sha256(bytes); meta.schemaHash = sha256(schemaBytes)
    writeFileSync(join(output, 'runner-snapshot.mts'), readFileSync(new URL(import.meta.url)))
    const dependencyHashes = Object.fromEntries(['quote-extraction.mts', '../grounding_lab/bounded_scoring.py', '../../../packages/extraction/src/source-context.ts', '../../../packages/extraction/src/parsed-document.ts'].map(path => [path, sha256(readFileSync(new URL(path, import.meta.url)))]))
    save('configuration.json', { ...meta, instruction: INSTRUCTION, quoteInstruction: QUOTE_INSTRUCTION, sourceCodeHash: sha256(readFileSync(new URL(import.meta.url))), dependencyHashes, recordTemplate, metadataTemplate })
    const base = process.env.FREE_LIVE_OLLAMA_URL ?? 'http://spark.cdch-dgxspark.lan.ku.dk:11434'
    const versionResponse = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(30000) })
    const tagsResponse = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(30000) })
    if (!versionResponse.ok || !tagsResponse.ok) throw new Error('Spark provenance endpoint failed')
    const version: any = await versionResponse.json(), tags: any = await tagsResponse.json()
    if (version.version !== '0.32.14' || !tags.models?.some((m: any) => m.name === MODEL && m.digest.replace(/^sha256:/, '') === MODEL_DIGEST)) throw new Error('Pinned Spark model/runtime unavailable')
    async function call(name: string, text: string, shape: any, instruction: string): Promise<any> {
      const request = { model: MODEL, messages: [{ role: 'user', content: `${instruction}\n\nSCHEMA:\n${JSON.stringify(shape)}\n\nSOURCE:\n${text}` }], format: jsonSchema(shape), stream: false, think: false, truncate: false, shift: false, options: { temperature: 0, num_ctx: meta.context, num_predict: meta.outputTokens, seed: 0 } }
      save(`${name}.request.json`, request)
      const entry: any = { name, startedAt: new Date().toISOString(), requestHash: sha256(JSON.stringify(request)), complete: false }
      meta.calls.push(entry)
      const callStarted = performance.now()
      save('workflow.json', meta)
      try {
        const raw = await postJson(`${base}/api/chat`, request)
        writeFileSync(join(output, `${name}.response.txt`), raw.text)
        if (raw.status !== 200) throw new Error(`HTTP ${raw.status}`)
        const response = JSON.parse(raw.text)
        Object.assign(entry, { inputTokens: response.prompt_eval_count, outputTokens: response.eval_count, finishReason: response.done_reason })
        validateCompletion(response, meta.outputTokens)
        if (response.prompt_eval_count + response.eval_count > meta.context) throw new Error('Context budget exceeded')
        const value = JSON.parse(response.message.content)
        validateTyped(value, shape)
        entry.complete = true
        return value
      } catch (error) { entry.error = String(error); throw error }
      finally { entry.durationSeconds = (performance.now() - callStarted) / 1000; save('workflow.json', meta) }
    }
    const discoveryStarted = performance.now()
    const found = await call('discovery', discoverySource, { records: [{ start: 'integer', end: 'integer', identityBlock: 'integer', identityQuote: 'string', contextBlocks: ['integer'] }] }, `${INSTRUCTION} This call discovers records only. Enumerate INDIVIDUAL burials, never one record per site. A site describing Grab 1, Grab 2, Grab 3 contributes three separate records, each with its own burial identity quote. A statement that four graves existed contributes no unnamed extra records. The identityBlock is the block containing that individual burial's identifier or, for a single unnumbered burial, its explicit burial description. identityQuote must be a distinctive verbatim passage FROM THAT BLOCK identifying the individual burial; a site heading alone is forbidden. For each burial give start block index inclusive and end block index exclusive covering its COMPLETE burial description and inventory. contextBlocks must list the source block indices for its site heading, shared site description and ALL applicable catalogue conventions, abbreviations, measurement-unit definitions and table headers outside that region. Include definitions even if they precede the entire site catalogue. Never assume a reader of this region already knows its site or units. Regions may overlap when graves share a site heading; their identity blocks and burial identity quotes must still identify distinct burials. Do not split a record at a page break or subsection heading. Return records in identity reading order, stopping only after 20 eligible individual burials or the end of the source. Block indices are zero-based.`)
    const requests = validateDiscovery(found.records, blocks)
    save('record-manifest.json', requests)
    meta.discoverySeconds = (performance.now() - discoveryStarted) / 1000
    for (const arm of ['baseline', 'quote']) {
      const armStarted = performance.now()
      const armDir = join(output, arm); mkdirSync(armDir)
      const armMeta: any = { complete: false, requestedRecords: requests.length, startedAt: new Date().toISOString() }
      meta.arms[arm] = armMeta
      try {
        const quote = arm === 'quote'
        const shape = quote ? wrapTemplate(metadataTemplate) : metadataTemplate
        const metadata = await call(`${arm}-metadata`, canonical.text, shape, `Extract only document-level metadata according to the supplied schema. ${INSTRUCTION} Do not emit records in this call. ${quote ? QUOTE_INSTRUCTION : ''}`)
        const unwrappedMetadata = quote ? unwrapQuotes(metadata, metadataTemplate) : { result: metadata, quotes: [] }
        const result: any = { ...unwrappedMetadata.result as object, records: [] }
        const quotes = [...unwrappedMetadata.quotes]
        for (let offset = 0; offset < requests.length; offset += meta.batchSize) {
          const batch = requests.slice(offset, offset + meta.batchSize)
          const batchShape = { records: [{ sourceKey: 'string', record: quote ? wrapTemplate(recordTemplate) : recordTemplate }] }
          const text = batch.map(r => `REQUEST ${r.sourceKey}: ${r.identityQuote}\nSHARED SOURCE CONTEXT:\n${r.contextBlocks.map(i => canonicalSourceSlice(document, i, i + 1)).join('\n')}\nCOMPLETE BURIAL REGION:\n${canonicalSourceSlice(document, r.start, r.end)}`).join('\n\n')
          const response = await call(`${arm}-batch-${offset}`, text, batchShape, `${INSTRUCTION} Extract EXACTLY these requested records in this order: ${batch.map(r => r.sourceKey).join(', ')}. sourceKey is a routing ID copied from REQUEST, never an extracted source identifier. Each record object must concern only that requested individual burial. Do not add neighbouring graves. ${quote ? QUOTE_INSTRUCTION : ''} The sourceKey routing field remains a plain string.`)
          validateBatch(response.records, batch)
          for (const row of response.records) {
            const item = quote ? unwrapQuotes(row.record, recordTemplate) : { result: row.record, quotes: [] }
            const index = result.records.length
            quotes.push(...item.quotes.map(q => ({ ...q, resultPath: ['records', index, ...q.resultPath] })))
            result.records.push(item.result)
          }
        }
        validateTyped(result, template)
        const signatures = result.records.map((r: unknown) => JSON.stringify(r))
        if (new Set(signatures).size !== signatures.length) throw new Error('Duplicate complete returned records')
        writeFileSync(join(armDir, 'raw_extracted.json'), JSON.stringify(result, null, 2))
        if (quote) writeFileSync(join(armDir, 'quote_mappings.json'), JSON.stringify(mapQuotes(canonical, quotes), null, 2))
        armMeta.extractionAndMappingSeconds = (performance.now() - armStarted) / 1000
        const scoring = spawnSync(join(process.cwd(), '.venv/Scripts/python.exe'), ['-X', 'utf8', '-m', 'grounding_lab.bounded_scoring', source, armDir], { encoding: 'utf8', timeout: 3600000 })
        writeFileSync(join(armDir, 'scoring.log'), (scoring.stdout ?? '') + (scoring.stderr ?? ''))
        if (scoring.status !== 0) throw new Error(`E scoring failed: ${scoring.error ?? scoring.status}`)
        armMeta.complete = true
        armMeta.returnedRecords = result.records.length
      } catch (error) { armMeta.error = String(error) }
      finally { armMeta.durationSeconds = (performance.now() - armStarted) / 1000; save('workflow.json', meta) }
    }
    meta.complete = Object.values(meta.arms).every((arm: any) => arm.complete)
  } catch (error) { meta.error = String(error) }
  finally {
    save('workflow.json', meta)
    meta.durationThroughOutputWriteSeconds = (performance.now() - started) / 1000
    meta.finishedAt = new Date().toISOString()
    save('workflow.json', meta)
    if (!meta.complete) process.exitCode = 1
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
