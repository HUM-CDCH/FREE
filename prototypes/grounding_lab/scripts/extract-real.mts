// Run FREE's real extractor over the benchmark documents so the grounding
// pipeline can be measured against typed model output instead of claim values
// hand-copied out of the anchors.
//
// Usage: pnpm --filter grounding-lab extract-real -- [<root>...] [--only <doc>]
// Writes <root>/<doc>/{template.json,extracted_raw.json,extracted_meta.json}.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeParsedDocument } from 'extraction/parsed-document'
import { canonicalSource } from 'extraction/source-context'
import type { GeneralExecutionTarget } from '../../studio/api/_provider.js'
import { templateFromSchema } from './quote-extraction.mts'
export { templateFromSchema } from './quote-extraction.mts'

const OLLAMA_URL = process.env.FREE_LIVE_OLLAMA_URL ?? 'http://127.0.0.1:11434'
const OLLAMA_MODEL = process.env.FREE_LIVE_OLLAMA_MODEL ?? 'qwen3.8:latest'
// Documents whose full markdown exceeds the context the local Ollama server
// actually grants (~32k tokens, not the model's advertised 262k): extract from
// a page window around the gold anchors instead (labelled in the metadata).
const WINDOWED = new Set([
  'desnz-annual-report-2024-25-en', 'us-census-income-2024-en', 'espana-en-cifras-2025-es',
  // blind-set scans over 300k characters
  'buchvaldek-1970-vikletice-tables-de', 'durankulak-catalogue-de',
])

async function target(): Promise<GeneralExecutionTarget> {
  const { providerTable } = await import('../../studio/api/_provider.js')
  const ollama = providerTable.ollama
  return {
    profile: 'general',
    model: ollama.createModel(
      { id: '22222222-2222-4222-8222-222222222222', name: 'grounding-lab local Ollama', provider: 'ollama', baseUrl: OLLAMA_URL },
      OLLAMA_MODEL,
      null,
    ),
    jsonOutput: ollama.jsonOutput,
    temperatureSupported: ollama.temperatureSupported,
  }
}

type Claim = { value: string; resultPath: (string | number)[]; goldAnchorId?: string | null; goldAnchorIds?: string[] }

// --- template derivation -----------------------------------------------------

const CURRENCY = /[\p{Sc}]/gu
/** 'number' when the hand-authored value is a single number once thousands
 * separators, spaces, %, currency symbols and trailing unit words are stripped;
 * 'integer' for a bare year; 'string' otherwise. */
export function fieldType(value: string): 'string' | 'number' | 'integer' {
  const s = value.replace(/ | /g, ' ').replace(CURRENCY, '').trim().replace(/^\+/, '')
  const head = /^-?[\d.,]+(?: \d{3})*/.exec(s)
  if (!head) return 'string'
  const rest = s.slice(head[0].length).trim()
  if (rest && !/^%?[\p{L} ]*$/u.test(rest)) return 'string'
  const digits = head[0].replace(/ /g, '')
  // "1.234,56" and "1,234.56" both read as grouped; a lone comma is a decimal.
  const plain = /^-?\d{1,3}(?:[.,]\d{3})+$/.test(digits)
    ? digits.replace(/[.,]/g, '')
    : digits.replace(',', '.')
  if (!/^-?\d+(\.\d+)?$/.test(plain)) return 'string'
  return !rest && /^\d{4}$/.test(plain) && +plain >= 1000 && +plain <= 2100 ? 'integer' : 'number'
}

type Node = { array: boolean; scalars: string[]; children: Map<string, Node> }
const node = (): Node => ({ array: false, scalars: [], children: new Map() })
const majority = (values: string[]): string | undefined =>
  values.reduce<string | undefined>((best, v) => (values.filter((x) => x === v).length > values.filter((x) => x === best).length ? v : best), values[0])

const leafCount = (n: Node): number =>
  n.children.size === 0 ? n.scalars.length : [...n.children.values()].reduce((sum, c) => sum + leafCount(c), 0)

/** claims.json resultPaths -> an Extraction Schema template. An array used both
 * as a scalar list and as a record list (the hand-authored sets disagree) takes
 * whichever usage carries more claims. `adversarial*` fields are excluded. */
export function deriveTemplate(claims: readonly Claim[]): Record<string, unknown> {
  const root = node()
  for (const claim of claims) {
    const path = claim.resultPath ?? []
    if (path.some((s) => typeof s === 'string' && s.startsWith('adversarial'))) continue
    let current = root
    for (const segment of path) {
      if (typeof segment === 'number') current.array = true
      else current = current.children.get(segment) ?? current.children.set(segment, node()).get(segment)!
    }
    if (current !== root) current.scalars.push(fieldType(claim.value))
  }
  const render = (n: Node): unknown => {
    const value =
      n.children.size === 0 || n.scalars.length > leafCount(n)
        ? majority(n.scalars) ?? 'string'
        : Object.fromEntries([...n.children].map(([name, child]) => [name, render(child)]))
    return n.array ? [value] : value
  }
  return Object.fromEntries([...root.children].map(([name, child]) => [name, render(child)]))
}

// --- document text -----------------------------------------------------------

function documentText(dir: string): { markdown: string; source: 'document.md' | 'canonicalSource' } {
  const md = join(dir, 'document.md')
  if (existsSync(md)) return { markdown: readFileSync(md, 'utf8'), source: 'document.md' }
  const parsed = decodeParsedDocument(JSON.parse(readFileSync(join(dir, 'parsed_document.json'), 'utf8')))
  return { markdown: canonicalSource(parsed), source: 'canonicalSource' }
}

/** Keep only the pages holding a gold anchor, plus one page either side. */
function windowPages(markdown: string, dir: string): { markdown: string; pages: number[] } {
  const anchors: { anchorId: string; page: number }[] = JSON.parse(readFileSync(join(dir, 'anchors.json'), 'utf8'))
  const pageById = new Map(anchors.map((a) => [a.anchorId, a.page]))
  const claims: Claim[] = JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8'))
  const keep = new Set<number>()
  for (const claim of claims)
    for (const id of claim.goldAnchorIds ?? (claim.goldAnchorId ? [claim.goldAnchorId] : [])) {
      const page = pageById.get(id)
      if (page === undefined) continue
      keep.add(page - 1), keep.add(page), keep.add(page + 1)
    }
  const sections = markdown.split(/(?=<!-- FREE:PAGE \d+ -->|^## Page \d+$)/m)
  const kept = sections.filter((section) => {
    const m = /^(?:<!-- FREE:PAGE (\d+) -->|## Page (\d+))/.exec(section)
    return m ? keep.has(+(m[1] ?? m[2])) : false
  })
  return { markdown: kept.join(''), pages: [...keep].filter((p) => p > 0).sort((a, b) => a - b) }
}

// --- main --------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const onlyIndex = args.indexOf('--only')
  const only = onlyIndex === -1 ? null : args[onlyIndex + 1]
  const roots = args.filter((a, i) => !a.startsWith('--') && !(onlyIndex !== -1 && i === onlyIndex + 1))
  let executionTarget: GeneralExecutionTarget | undefined
  for (const root of roots.length ? roots : ['dataset', 'final_dataset', 'final_dataset_2']) {
    for (const name of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name)) {
      if (only && name !== only) continue
      const dir = join(root, name)
      const schema = join(dir, 'schema.json')
      const claimsPath = join(dir, 'claims.json')
      if (!existsSync(schema) && !existsSync(claimsPath)) continue
      const template = existsSync(schema) ? templateFromSchema(readFileSync(schema, 'utf8'))
        : deriveTemplate(JSON.parse(readFileSync(claimsPath, 'utf8')) as Claim[])
      writeFileSync(join(dir, 'template.json'), JSON.stringify(template, null, 2) + '\n')
      if (args.includes('--templates-only')) continue
      if (args.includes('--resume') && existsSync(join(dir, 'extracted_raw.json'))) {
        process.stderr.write(`${dir}: already extracted, skipped\n`)
        continue
      }
      const full = documentText(dir)
      const windowed = WINDOWED.has(name) && existsSync(claimsPath) ? windowPages(full.markdown, dir) : null
      const markdown = windowed?.markdown ?? full.markdown
      const started = Date.now()
      process.stderr.write(`${dir}: ${markdown.length} chars${windowed ? ` (windowed to ${windowed.pages.length} pages)` : ''} ... `)
      try {
        const { extractWithModel } = await import('../../studio/api/_model.js')
        executionTarget ??= await target()
        const result = await extractWithModel({ document: { file: null, markdown, pages: null }, template, temperature: 0 }, executionTarget)
        writeFileSync(join(dir, 'extracted_raw.json'), JSON.stringify(result.result, null, 2) + '\n')
        writeFileSync(
          join(dir, 'extracted_meta.json'),
          JSON.stringify(
            {
              model: OLLAMA_MODEL, provider: 'ollama', baseUrl: OLLAMA_URL, temperature: 0,
              documentSource: full.source, markdownChars: markdown.length,
              windowed: windowed ? { pages: windowed.pages, fullMarkdownChars: full.markdown.length } : null,
              elapsedSeconds: (Date.now() - started) / 1000,
              modelAttribution: result.modelAttribution, metadata: result.metadata, error: null,
            }, null, 2,
          ) + '\n',
        )
        process.stderr.write(`ok ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
      } catch (error) {
        writeFileSync(
          join(dir, 'extracted_meta.json'),
          JSON.stringify(
            {
              model: OLLAMA_MODEL, provider: 'ollama', baseUrl: OLLAMA_URL, temperature: 0,
              documentSource: full.source, markdownChars: markdown.length,
              windowed: windowed ? { pages: windowed.pages, fullMarkdownChars: full.markdown.length } : null,
              elapsedSeconds: (Date.now() - started) / 1000,
              modelAttribution: null, metadata: null, error: String(error),
            }, null, 2,
          ) + '\n',
        )
        process.stderr.write(`FAILED ${String(error).slice(0, 300)}\n`)
      }
    }
  }
}

if (process.argv[1]?.endsWith('extract-real.mts')) await main()
