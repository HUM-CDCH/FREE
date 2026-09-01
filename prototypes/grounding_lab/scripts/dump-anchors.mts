// Dump the canonical anchor inventory of a parsed_document.json to anchors.json
// for the Python harness. Uses the app's own reading-order logic instead of
// re-parsing rendered source text (which loses table-cell text after ` | `).
// Usage: pnpm dump-anchors <parsed_document.json> <anchors.json>
import { readFileSync, writeFileSync } from 'node:fs'
import { decodeParsedDocument } from 'extraction/parsed-document'
import { canonicalAnchorInventory } from 'extraction/source-context'

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error('Usage: dump-anchors <parsed_document.json> <anchors.json>')
  process.exit(1)
}
const document = decodeParsedDocument(JSON.parse(readFileSync(input, 'utf8')))
const inventory = canonicalAnchorInventory(document)
// Row context disambiguates table cells whose own text is identical (e.g. a
// year column) — neural tiers score `context`, lexical matching stays on `text`.
const rowTexts = new Map<string, string[]>()
for (const entry of inventory) {
  if (entry.kind !== 'table_cell') continue
  const key = `${entry.logicalTableId}\t${entry.row}`
  rowTexts.set(key, [...(rowTexts.get(key) ?? []), entry.text])
}
const entries = inventory.map((entry) => ({
  anchorId: entry.anchorId,
  text: entry.text,
  page: entry.page,
  kind: entry.kind,
  ...(entry.kind === 'table_cell'
    ? {
        context: `${rowTexts
          .get(`${entry.logicalTableId}\t${entry.row}`)!
          .join(' | ')} — ${entry.text}`,
      }
    : {}),
}))
writeFileSync(output, JSON.stringify(entries, null, 2) + '\n')
console.error(`Wrote ${entries.length} anchors to ${output}`)
