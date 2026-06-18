import { generateText } from 'ai'
import { createOllama } from 'ai-sdk-ollama'
import { readFileSync } from 'node:fs'

const MODEL = process.env.MODEL || 'hf.co/numind/NuExtract3-GGUF:Q4_K_M'
const model = createOllama({ baseURL: 'http://127.0.0.1:11434' })(MODEL)

const SYSTEM =
  'You are a precise information extraction assistant. Return faithful, source-grounded results only.'
const TASK =
  'Generate a concise JSON extraction template for the supplied document or text. Use descriptive field names and simple type hints such as string, number, YYYY-MM-DD, boolean, or arrays of objects. Return only the JSON template.'

const pdf = readFileSync('public/Beretning_Ellekilde_8_13.pdf')
const jpegs = ['/tmp/free_page-1.jpg', '/tmp/free_page-2.jpg'].map((p) => readFileSync(p))

async function run(label, content) {
  const t = Date.now()
  try {
    const r = await generateText({ model, system: SYSTEM, messages: [{ role: 'user', content }], maxOutputTokens: 4000 })
    console.log(`\n===== ${label} (${Math.round((Date.now() - t) / 1000)}s) =====\n${r.text}`)
  } catch (e) {
    console.log(`\n===== ${label} — ERROR (${Math.round((Date.now() - t) / 1000)}s) =====\n${e.message}`)
  }
}

// BEFORE: raw application/pdf part — what the buggy code sent.
await run('BEFORE: raw application/pdf part', [
  { type: 'text', text: TASK },
  { type: 'file', data: pdf, mediaType: 'application/pdf', filename: 'doc.pdf' },
])

// AFTER: rasterised image/jpeg page parts — the fix.
await run('AFTER: image/jpeg page parts', [
  { type: 'text', text: TASK },
  ...jpegs.map((data, i) => ({ type: 'file', data, mediaType: 'image/jpeg', filename: `page-${i + 1}.jpg` })),
])
