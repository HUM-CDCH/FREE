// Dump the canonical anchor inventory of a parsed_document.json to anchors.json
// for the Python harness. Uses the app's own reading-order logic instead of
// re-parsing rendered source text (which loses table-cell text after ` | `).
// Usage: pnpm dump-anchors <parsed_document.json> <anchors.json>
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { decodeParsedDocument, type ParsedLogicalTable } from 'extraction/parsed-document'
import { canonicalAnchorInventory } from 'extraction/source-context'

type ContextCell = Pick<ParsedLogicalTable['cells'][number], 'row' | 'column' | 'text' | 'role' | 'colspan' | 'evidence_anchor_id'>

export function tableCellContexts(cells: readonly ContextCell[]): Map<string, string> {
  const sorted = [...cells].sort((left, right) => left.row - right.row || left.column - right.column)
  const rowTexts = new Map<number, string[]>()
  for (const cell of sorted) rowTexts.set(cell.row, [...(rowTexts.get(cell.row) ?? []), cell.text])
  const contexts = new Map<string, string>()
  // ponytail: quadratic scans are fine for offline dataset dumps; index roles if large tables make this slow.
  for (const cell of sorted) {
    const headerRows = [...new Set(sorted
      .filter((candidate) => candidate.role === 'column_header' && candidate.row < cell.row)
      .map((candidate) => candidate.row))]
    const lastHeaderRow = headerRows.at(-1)
    let firstHeaderRow = lastHeaderRow
    while (firstHeaderRow !== undefined && headerRows.includes(firstHeaderRow - 1)) firstHeaderRow--
    const isHeader = HEADER_ROLES.has(cell.role ?? '')
    const headers = isHeader
      ? []
      : [
          ...sorted.filter((c) => c.role === 'row_section' && c.row < cell.row).slice(-1),
          ...sorted.filter((c) => c.role === 'row_header' && c.row === cell.row),
          ...sorted.filter((c) => c.role === 'column_header'
            && firstHeaderRow !== undefined && c.row >= firstHeaderRow && c.row <= lastHeaderRow!
            && c.column <= cell.column && cell.column < c.column + c.colspan),
        ].map((c) => c.text)
    // A header cell labels its row, it does not state the row's values: giving
    // it the whole row made every data cell's value read as part of the
    // header's own passage, so a scorer asked for "the passage stating the
    // value" could pick the label. Its own text is the whole scope.
    const scope = isHeader
      ? [cell.text]
      : [...headers, ...rowTexts.get(cell.row)!.filter((text) => !headers.includes(text))]
    contexts.set(cell.evidence_anchor_id, `${scope.join(' | ')} — ${cell.text}`)
  }
  return contexts
}

// Table-cell context disambiguates cells whose own text is identical (e.g. a
// year column) — neural tiers score `context`, lexical matching stays on `text`.
// A data cell is prefixed with its row headers and the column headers above
// it when the parser labelled them (every cell of a row otherwise shares one
// text and a reranker cannot tell the 2025 column from 2027), then the whole
// row: yearbook layouts pack several sub-tables into one parsed table, so a
// header alone can be wrong while the row still separates the cells.
const HEADER_ROLES = new Set(['column_header', 'row_header', 'row_section'])
function main(): void {
  const [input, output] = process.argv.slice(2)
  if (!input || !output) {
    console.error('Usage: dump-anchors <parsed_document.json> <anchors.json>')
    process.exit(1)
  }
  const document = decodeParsedDocument(JSON.parse(readFileSync(input, 'utf8')))
  const inventory = canonicalAnchorInventory(document)
  const cellContext = new Map(document.tables.flatMap((table) => [...tableCellContexts(table.cells)]))
  const entries = inventory.map((entry) => ({
    anchorId: entry.anchorId,
    text: entry.text,
    page: entry.page,
    kind: entry.kind,
    ...(entry.kind === 'table_cell' ? { context: cellContext.get(entry.anchorId)! } : {}),
  }))
  writeFileSync(output, JSON.stringify(entries, null, 2) + '\n')
  console.error(`Wrote ${entries.length} anchors to ${output}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
