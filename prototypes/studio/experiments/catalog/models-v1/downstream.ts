/** Frozen NuExtract prompt and linker, fed new OCR text; coarse image evidence. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { lexicalCandidates } from '../link.js'
import { fields } from '../schema.js'

const { values: args } = parseArgs({ options: { ocr: { type: 'string' }, out: { type: 'string' }, mode: { type: 'string', default: 'columns' } } })
if (!args.ocr || !args.out || !['columns', 'full'].includes(args.mode!)) throw new Error('Required --ocr --out --mode columns|full')
const root = resolve('../../artifacts/catalog-lab/beier/models-v1')
const out = resolve(args.out)
await mkdir(out)
type Candidate = { anchorId: string; text: string }
const images = JSON.parse(await readFile(join(root, 'images.json'), 'utf8')).filter((i: { column: number }) => Boolean(i.column) === (args.mode === 'columns'))
const records: { number: number; candidates: Candidate[] }[] = []
const sourceOutputs = []
let current: typeof records[number] | undefined
for (const image of images) {
  const bytes = await readFile(join(resolve(args.ocr), `${image.id}.json`))
  const output = JSON.parse(bytes.toString())
  sourceOutputs.push({ image, outputSha256: createHash('sha256').update(bytes).digest('hex'), tokenLimited: output.hitTokenLimit })
  // Preserve reading order, join wrapped lines; no answer/reference-based correction.
  const plain = output.text.replace(/<x_[^>]+><y_[^>]+>([\s\S]*?)<x_[^>]+><y_[^>]+><class_[^>]+>/g, '$1\n\n')
  const lines = plain.replace(/(?<=\p{L})-\s*\n\s*(?=\p{L})/gu, '').split(/\r?\n/)
  let paragraph = ''
  const flush = () => { if (current && paragraph.trim()) current.candidates.push({ anchorId: image.id, text: paragraph.trim() }); paragraph = '' }
  for (const raw of lines) {
    const line = raw.replace(/^\s*#{1,6}\s*/, '').replace(/\*\*/g, '').trim()
    const start = /^(\d{3})\.\s+\p{L}/u.exec(line)
    if (start) { flush(); current = { number: Number(start[1]), candidates: [] }; records.push(current) }
    if (!line) flush()
    else paragraph += (paragraph ? ' ' : '') + line
  }
  flush()
}
const inputSha256 = createHash('sha256').update(JSON.stringify(sourceOutputs)).digest('hex')
await writeFile(join(out, 'input.json'), JSON.stringify({ inputSha256, sourceOutputs, records }, null, 2))
const template = JSON.parse(await readFile(join(root, '../desktop-b3-r3/call-001-actual-ollama-request.json'), 'utf8'))
const calls: { model: string; phase: string; durationMs: number; providerInvocations: number }[] = []
const rows: { values: Record<string, unknown>; evidence: Record<string, string[]>; issues: string[] }[] = []
const started = performance.now()
let failure: string | null = null
try {
  for (let offset = 0; offset < records.length; offset += 3) {
    const group = records.slice(offset, offset+3)
    const text = group.map((r, i) => `### Source record ${i+1}\n${r.candidates.map(c => c.text).join('\n')}`).join('\n\n')
    const request = { ...template, prompt: template.prompt.replace(/each of the 3 source records/, `each of the ${group.length} source records`).replace(/【document_start】[\s\S]*?【document_end】/, () => `【document_start】\n${text}\n【document_end】`) }
    await writeFile(join(out, `call-${calls.length+1}-request.json`), JSON.stringify(request, null, 2))
    const begin = performance.now()
    const response = await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(180000) })
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`)
    const raw = await response.json()
    calls.push({ model: 'nuextract', phase: 'grouped-values', durationMs: Math.round(performance.now()-begin), providerInvocations: 1 })
    await writeFile(join(out, `call-${calls.length}-response.json`), JSON.stringify(raw, null, 2))
    if (raw.done_reason === 'length') throw new Error('Truncated extraction response')
    const result = JSON.parse(raw.response)
    if (!Array.isArray(result.records)) throw new Error('No records array')
    for (const value of result.records) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid record')
      const candidates = group.find(r => r.number === value.catalog_number)?.candidates ?? []
      const row = { values: Object.fromEntries(fields.map(f => [f, value[f] ?? null])), evidence: {} as Record<string, string[]>, issues: [] as string[] }
      for (const field of fields) {
        const hits = lexicalCandidates(field, row.values[field], candidates, true)
        row.evidence[field] = hits.length === 1 ? [hits[0].anchorId] : []
        if (row.values[field] != null && hits.length !== 1) row.issues.push(`ungrounded:${field}`)
      }
      rows.push(row)
    }
    console.log('Extracted batch', calls.length, 'rows', rows.length)
  }
} catch (error) { failure = String(error); process.exitCode = 1 }
await writeFile(join(out, 'result.json'), JSON.stringify({ inputSha256, rows, calls, failure, model: 'nuextract', strategy: `ocr-${args.mode}-b3-lexical`, durationMs: Math.round(performance.now()-started), evidenceGranularity: args.mode === 'columns' ? 'source-column' : 'source-page', discoveredRecords: records.length }, null, 2))
