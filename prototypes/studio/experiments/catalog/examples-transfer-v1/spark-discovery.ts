/** Generalist Discovery on Spark; original NuExtract extraction remains unchanged. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { decodeParsedDocument } from '../../../../../packages/extraction/src/parsed-document.js'
import { resolveCatalogBoundaries } from '../../../../../packages/extraction/src/catalog-boundaries.js'

const root = resolve('../../artifacts/catalog-lab/examples-transfer-v1')
const base = 'http://spark.cdch-dgxspark.lan.ku.dk:11434'
const model = 'qwen3.8:27b'
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const save = async (path: string, data: unknown) => writeFile(path, JSON.stringify(data, null, 2), { flag: 'wx' })
const cases = (await read(join(root, 'reference.json'))).cases as { name: string }[]
const prepare = process.argv.includes('--prepare')
for (const item of cases) {
  const directory = join(root, item.name)
  const out = join(directory, 'spark-qwen-discovery-r1')
  const old = await read(join(directory, 'discovery-r1/request.json'))
  const instruction = old.prompt.split('【instructions_start】')[1].split('【instructions_end】')[0]
  const text = old.prompt.split('【document_start】')[1].split('【document_end】')[0]
  const source = await readFile(join(directory, 'parsed_document.json'))
  const inputSha256 = createHash('sha256').update(source).digest('hex')
  const body = { model, raw: true, stream: false, format: 'json',
    options: { temperature: 0.2, num_ctx: 65536, num_predict: 4096 },
    // The server's imported Qwen tag has a passthrough template ({{ .Prompt }}).
    // Supply Qwen role delimiters explicitly and close thinking for direct JSON.
    prompt: `<|im_start|>system\n${instruction}<|im_end|>\n<|im_start|>user\n${text}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n` }
  if (prepare) {
    await mkdir(out)
    await save(join(out, 'request.json'), body)
    await save(join(out, 'input.json'), { inputSha256, sourceCharacters: text.length, endpoint: base })
    continue
  }
  if (JSON.stringify(await read(join(out, 'request.json'))) !== JSON.stringify(body)) throw new Error('Frozen request changed')
  const document = decodeParsedDocument(JSON.parse(source.toString()))
  const labels = (await read(join(directory, 'discovery-r1/input.json'))).labels as Record<string, string>
  let boundaries: ReturnType<typeof resolveCatalogBoundaries> = [], failure: string | null = null
  const start = performance.now()
  try {
    const response = await fetch(base+'/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(300000) })
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`)
    const raw = await response.json()
    await save(join(out, 'response.json'), raw)
    if (!raw.done || raw.done_reason === 'length') throw new Error('Incomplete Discovery')
    const answer = JSON.parse(raw.response)
    if (!Array.isArray(answer.starts) || !(answer.end === null || typeof answer.end === 'string') ||
      Object.keys(answer).some(k => !['starts', 'end'].includes(k))) throw new Error('Invalid Discovery shape')
    const lookup = (label: unknown): string => {
      if (typeof label !== 'string' || !Object.hasOwn(labels, label)) throw new Error(`Unknown label ${String(label)}`)
      return labels[label]
    }
    boundaries = resolveCatalogBoundaries(document, answer.starts.map(lookup), answer.end === null ? undefined : lookup(answer.end))
  } catch (error) { failure = String(error) }
  const durationMs = Math.round(performance.now()-start)
  await save(join(out, 'result.json'), { inputSha256, boundaries, failure,
    calls: [{ phase: 'discovery', model, durationMs, providerInvocations: 1, status: failure ? 'failed' : 'succeeded' }] })
  console.log(JSON.stringify({ document: item.name, starts: boundaries.map(b => b.headingText), durationMs, failure }))
}
