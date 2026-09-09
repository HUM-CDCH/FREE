/** Rebuild a local-only baseline; never reuse Luna's evidence selections. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { decodeParsedDocument } from '../../../../../packages/extraction/src/parsed-document.js'
import { canonicalAnchorInventory } from '../../../../../packages/extraction/src/source-context.js'
import { lexicalCandidates } from '../link.js'
import { fields } from '../schema.js'

const { values } = parseArgs({ options: {
  document: { type: 'string' }, baseline: { type: 'string' }, out: { type: 'string' },
} })
if (!values.document || !values.baseline || !values.out) throw new Error('Required: --document --baseline --out')
const bytes = await readFile(resolve(values.document))
const document = decodeParsedDocument(JSON.parse(bytes.toString()))
const baseline = JSON.parse(await readFile(resolve(values.baseline), 'utf8'))
if (createHash('sha256').update(bytes).digest('hex') !== baseline.inputSha256) throw new Error('Snapshot mismatch')
const inventory = canonicalAnchorInventory(document)
const claims = []
for (let i = 0; i < baseline.rows.length; i++) {
  const row = baseline.rows[i]
  const boundary = baseline.boundaries[i]
  if (!boundary || !boundary.headingText.startsWith(`${row.values.catalog_number}. `)) throw new Error('Boundary mismatch')
  const blockIds = new Set(document.content_stream.slice(boundary.startContentIndex, boundary.endContentIndex).map(b => b.block_id))
  const anchorIds = new Set(document.evidence_index.anchors.filter(a => a.kind === 'text' && blockIds.has(a.block_id)).map(a => a.anchor_id))
  const candidates = inventory.filter(e => anchorIds.has(e.anchorId))
  row.evidence = {}
  row.issues = []
  for (const field of fields) {
    const hits = lexicalCandidates(field, row.values[field], candidates, true)
    row.evidence[field] = hits.length === 1 ? [hits[0].anchorId] : []
    if (row.values[field] != null && hits.length !== 1) row.issues.push(`lexical-${hits.length ? 'ambiguous' : 'missing'}:${field}`)
  }
  if (row.values.burial_axis == null) continue
  const hits = new Set(lexicalCandidates('burial_axis', row.values.burial_axis, candidates, true).map(e => e.anchorId))
  const selected = new Set([0])
  candidates.forEach((c, n) => {
    if (hits.has(c.anchorId)) for (const index of [n - 1, n, n + 1]) if (index >= 0 && index < candidates.length) selected.add(index)
  })
  // No lexical hit: retain the whole record so the verifier can still abstain.
  const context = hits.size ? candidates.filter((_, n) => selected.has(n)) : candidates
  let text = ''
  const blocks = context.map(c => {
    if (text) text += '\n\n'
    const start = text.length
    text += c.text
    return { anchorId: c.anchorId, text: c.text, start, end: text.length }
  })
  claims.push({ catalog_number: row.values.catalog_number, value: row.values.burial_axis, text, blocks })
}
baseline.calls = baseline.calls.filter((c: { model: string }) => c.model === 'nuextract')
baseline.durationMs = baseline.calls.reduce((sum: number, c: { durationMs: number }) => sum + c.durationMs, 0)
baseline.strategy = 'derived-local-lexical'
baseline['fallback-model'] = null
baseline.failure = null
baseline.executionStatus = 'complete'
baseline.provenance = { derivedFrom: resolve(values.baseline), note: 'Reused NuExtract values only; all evidence recomputed. Duration is sum of reused extraction calls, not a new end-to-end measurement.' }
await mkdir(resolve(values.out), { recursive: true })
await writeFile(join(values.out, 'local-baseline.json'), JSON.stringify(baseline, null, 2), { flag: 'wx' })
await writeFile(join(values.out, 'claims.json'), JSON.stringify({ inputSha256: baseline.inputSha256, claims }, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ records: baseline.rows.length, claims: claims.map(c => ({ id: c.catalog_number, value: c.value, characters: c.text.length })) }))
