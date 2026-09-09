/** Production executor versus the frozen batch-3 experiment; no application writes. */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'
import { z } from 'zod'
import { createExtractionJobExecutor } from '../../../../../packages/extraction/src/module.js'
import { decodeParsedDocument } from '../../../../../packages/extraction/src/parsed-document.js'
import { schemaNodesToZod, templateToNodes } from '../../../../../packages/extraction/src/schema.js'
import type { ExtractionModelRequest } from '../../../../../packages/extraction/src/dependencies.js'
import type { TerminalExtraction } from '../../../../../packages/extraction/src/dependencies.js'
import { extractWithModel } from '../../../api/_model.js'
import { fields, schemaDefinition } from '../schema.js'

const root = resolve('../../artifacts/catalog-lab/examples-transfer-v1')
const endpoint = 'http://spark.cdch-dgxspark.lan.ku.dk:11434'
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const save = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2))
const frozenRunner = await readFile('experiments/catalog/run.ts', 'utf8')
const groundingLead = /const groundingLead = '([^']+)'/.exec(frozenRunner)![1]
const guardrail = 'Only extract fields defined in the Extraction Schema above. Do not invent, infer, or include any field, key, or record that is not present in the schema.'
const models = ['qwen3.8:27b', 'gemma4:12b-it-qat']
const hashes = Object.fromEntries(await Promise.all(['run.ts', 'schema.ts', 'link.ts', 'examples.ts', 'examples-transfer-v1/compare.ts'].map(async p => [p, createHash('sha256').update(await readFile('experiments/catalog/'+p)).digest('hex') ])))
if (process.argv.includes('--check')) {
  if (!groundingLead || !frozenRunner.includes("'grouped-lexical'")) throw Error('Frozen runner contract changed')
  console.log('Local contract check passed', hashes)
  process.exit(0)
}
for (const model of models) for (const item of (await read(join(root, 'reference.json'))).cases) {
  const directory = join(root, item.name)
  const name = model.startsWith('qwen') ? 'qwen' : 'gemma12'
  const out = join(directory, 'prod-'+name+'-r2')
  if (await access(join(out,'result.json')).then(() => true, () => false)) continue
  await mkdir(out) // Never overwrite a previous attempt.
  const bytes = await readFile(join(directory, 'parsed_document.json'))
  const document = decodeParsedDocument(JSON.parse(bytes.toString()))
  const inputSha256 = createHash('sha256').update(bytes).digest('hex')
  const calls: Record<string, unknown>[] = []
  const started = performance.now()
  await save(join(out, 'manifest.json'), { model, endpoint, inputSha256, hashes, schemaDefinition })
  async function invoke(request: ExtractionModelRequest, phase: string) {
    const prefix = join(out, `call-${String(calls.length+1).padStart(3,'0')}`)
    const begin = performance.now()
    const call: Record<string, unknown> = { phase, model: phase === 'extraction' ? 'nuextract' : model, status: 'failed', providerInvocations: 1 }
    calls.push(call)
    console.log('START', item.name, name, calls.length, phase)
    await save(prefix+'-request.json', { ...request, signal: undefined, outputSchema: request.outputSchema ? z.toJSONSchema(request.outputSchema) : null })
    try {
      let response
      if (phase === 'extraction') {
        response = await extractWithModel({ ...request, document: { ...request.document, file: null } }, {
          profile: 'nuextract-raw', modelId: 'hf.co/numind/NuExtract3-GGUF:Q4_K_M', baseUrl: 'http://127.0.0.1:11434',
          authorization: null, temperatureSupported: true,
          attribution: { provider: 'ollama', modelId: 'hf.co/numind/NuExtract3-GGUF:Q4_K_M' },
        }, { fetch: async (url, init) => { await writeFile(prefix+'-actual-request.json', String(init?.body)); return fetch(url, init) } })
      } else {
        const system = 'Produce a FREE Extraction Result. Follow the supplied Extraction Schema exactly. Return only one JSON object with no Markdown or commentary. Keep every repeated item inside its schema array; close the root object only after the final item. '+guardrail
        const user = ['Extract information from the Source Document using this Extraction Schema:', JSON.stringify(request.template, null, 2),
          ...(request.instruction?.trim() ? ['Additional extraction instruction:\n'+request.instruction.trim()] : [])].join('\n\n')
          +'\n\nSOURCE DOCUMENT:\n'+request.document.markdown+'\nEND SOURCE DOCUMENT\n\nReturn the JSON object now.'
        const prompt = model.startsWith('qwen')
          ? `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`
          : `<|turn>system\n${system}<turn|>\n<|turn>user\n${user}<turn|>\n<|turn>model\n<|channel>thought\n<channel|>`
        const format = z.toJSONSchema(request.outputSchema ?? schemaNodesToZod(templateToNodes(request.template)))
        const body = { model, raw: true, stream: false, prompt, format, options: { temperature: 0, num_ctx: 32768, num_predict: 4096 } }
        await save(prefix+'-actual-request.json', body)
        const http = await fetch(endpoint+'/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: request.signal })
        if (!http.ok) throw Error('Ollama HTTP '+http.status+': '+await http.text())
        const raw = await http.json()
        await save(prefix+'-raw-response.json', raw)
        if (!raw.done || raw.done_reason === 'length') throw Error('Incomplete response')
        response = { result: JSON.parse(raw.response), metadata: { finishReason: raw.done_reason, inputTokens: raw.prompt_eval_count, outputTokens: raw.eval_count, durationMs: Math.round(performance.now()-begin) } }
      }
      call.status = 'succeeded'; call.metadata = response.metadata
      await save(prefix+'-response.json', response)
      return response
    } catch (error) { call.error = String(error); throw error }
    finally { call.durationMs = Math.round(performance.now()-begin); await save(join(out,'calls.json'), calls); console.log('END', call.status, call.durationMs) }
  }
  const execute = createExtractionJobExecutor({
    inputs: {
      async loadExtractionInputs() { return { sourceDocumentId: 'prototype-source', projectContextId: 'prototype', sourceRepresentationRevisionId: 'prototype-source-revision', schemaRevisionId: 'prototype-schema', schemaTree: schemaDefinition, parsedDocument: document } },
      async readExtractionAttempt() { return null },
    },
    models: { async open() { return {
      attribution: { provider: 'ollama', modelId: model+' discovery/grounding + local NuExtract values' },
      model: { extract: (request) => invoke(request, 'starts' in request.template ? 'discovery' : 'extraction') },
      groundingModel: { async ground(request) {
        const response = await invoke({ document: { markdown: ['### Canonical Evidence', ...Object.entries(request.anchors).map(([l,t]) => `[${l}] ${t}`)].join('\n'), pages: document.page_count },
          template: { links: Object.fromEntries(Object.keys(request.claims).map(c => [c,'verbatim-string'])) },
          instruction: [groundingLead, '', '### Claims', ...Object.entries(request.claims).map(([l,v]) => `[${l}] ${JSON.stringify(v)}`)].join('\n'), signal: request.signal }, 'grounding')
        const links = response.result.links
        if (Object.keys(response.result).length !== 1 || !links || typeof links !== 'object' || Array.isArray(links)) throw Error('Invalid grounding envelope')
        const selections = Object.entries(links).map(([claimLabel,label]) => {
          if (typeof label !== 'string' || !label) throw Error('Invalid grounding selection')
          return { claimLabel, anchorLabel: label === 'NONE' ? null : label }
        })
        return { selections, metadata: response.metadata }
      } },
    } } },
  })
  let terminal: TerminalExtraction
  try {
    terminal = await execute({ kind: 'fresh', extractionId: 'prototype-run', sourceRepresentationRevisionId: 'prototype-source-revision', schemaRevisionId: 'prototype-schema', strategy: 'CATALOG' }, null,
      checkpoint => save(join(out,'checkpoint.json'), checkpoint), AbortSignal.timeout(1800000))
  } catch (error) {
    await save(join(out,'result.json'), { inputSha256, calls, boundaries: [], rows: [], failure: String(error), outcome: 'THREW', durationMs: Math.round(performance.now()-started) })
    const batchOut = join(directory,'batch3-'+name+'-r2')
    await mkdir(batchOut); await save(join(batchOut,'result.json'), { inputSha256, boundaries: [], rows: [], calls: [], skipped: 'Production execution threw before terminal result', failure: String(error) })
    console.log('PRODUCTION FAILED', item.name, name, String(error)); continue
  }
  await save(join(out,'terminal.json'), terminal)
  const boundaries = terminal.diagnostics.catalog?.records.map(r => r.boundary) ?? []
  const rows = (terminal.result?.records as Record<string,unknown>[] ?? []).map((values,index) => ({ values,
    evidence: Object.fromEntries(fields.map(field => [field, (terminal.evidence ?? []).filter(e => e.resultPath[1] === index && e.resultPath[2] === field).map(e => e.evidenceAnchorId)])) }))
  await save(join(out,'result.json'), { inputSha256, calls, boundaries, rows, failure: terminal.failure, outcome: terminal.outcome, durationMs: Math.round(performance.now()-started) })
  console.log('PRODUCTION DONE', item.name, name, terminal.outcome, boundaries.length, rows.length)
  const batchOut = join(directory,'batch3-'+name+'-r2')
  if (!boundaries.length) { await mkdir(batchOut); await save(join(batchOut,'result.json'), { inputSha256, boundaries: [], rows: [], calls: [], skipped: 'Production Discovery supplied no boundaries' }); continue }
  const code = await new Promise<number|null>((done, reject) => {
    const child = spawn(process.execPath, ['--import','tsx','experiments/catalog/run.ts','--input',join(directory,'parsed_document.json'),'--out',batchOut,
      '--strategy','grouped-lexical','--discovery-from',join(out,'result.json'),'--model','nuextract','--ollama-url','http://127.0.0.1:11434','--batch-size','3','--few-shot','--field-aware'], { stdio:'inherit' })
    child.once('error', reject); child.once('exit', done)
  })
  console.log('BATCH DONE', item.name, name, code)
}
