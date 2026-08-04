import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractWithModel } from '../api/_model.js'
import { buildHighlights, PALETTE } from '../src/evidenceHighlights'
import { parseParsedTables } from '../src/parsedDocument'
import { buildSegmentGeometryIndex } from '../src/segmentGeometry'
import { computeOccurrenceIndices, resolveTableCellMatches } from '../src/tableCellMatch'

const DEFAULT_PARSED_DOCUMENT =
  '../parsing_service/data/documents/fbd6884163b68656687d4c6ab7395be6ea306a5faf7b94253f18eb50c60b9679/parsed_document.json'
const DEFAULT_OUT_DIR = '../parsing_service/data/diagnostics/real-extraction-routing'

const TEMPLATE = {
  _strategy: 'catalog',
  records: [{
    grav_id: 'verbatim-string',
    table_number: 'verbatim-string',
    table_description: 'verbatim-string',
    table_notes: 'verbatim-string',
  }],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function linkedTableCount(tables: unknown): number {
  if (!Array.isArray(tables)) return 0
  return tables.filter((table) =>
    isRecord(table) &&
    typeof table.canonical_markdown_start === 'number' &&
    typeof table.canonical_markdown_end === 'number',
  ).length
}

const runDiagnostic = process.env.RUN_REAL_EXTRACTION_ROUTING_DIAGNOSTIC === '1'

describe.skipIf(!runDiagnostic)('real extraction highlight routing diagnostic', () => {
  it('calls the real model on cached canonical Markdown and writes routing diagnostics', async () => {
    const parsedDocumentPath = resolve(process.env.REAL_PARSED_DOCUMENT ?? DEFAULT_PARSED_DOCUMENT)
    const outDir = resolve(process.env.REAL_ROUTING_OUT_DIR ?? DEFAULT_OUT_DIR)
    const parsedDocument = JSON.parse(readFileSync(parsedDocumentPath, 'utf8')) as Record<string, unknown>
    const textViews = isRecord(parsedDocument.text_views) ? parsedDocument.text_views : {}
    const markdown = typeof textViews.llm_markdown === 'string' ? textViews.llm_markdown : ''
    expect(markdown.length).toBeGreaterThan(0)

    const extraction = await extractWithModel({
      document: { file: null, markdown, pages: null },
      template: TEMPLATE,
      hasTables: true,
    })

    const parsedTables = parseParsedTables(parsedDocument.tables)
    const schemaKeys = Object.keys(TEMPLATE.records[0])
    const fieldColorMap: Record<string, string> = {}
    schemaKeys.forEach((key, index) => { fieldColorMap[key] = PALETTE[index % PALETTE.length] })
    const highlights = buildHighlights(
      extraction.result,
      extraction.evidence,
      fieldColorMap,
      TEMPLATE,
    ).filter((highlight) => highlight.sourceScope !== null)
    const sourceScopes = highlights.map((highlight) => highlight.sourceScope!)
    const geometryIndex = buildSegmentGeometryIndex([], parsedTables, sourceScopes)
    const occurrenceIndices = computeOccurrenceIndices(highlights)

    const segmentReports = [...geometryIndex.entries()].map(([segmentId, geometry]) => ({
      segmentId,
      ownedTables: geometry.tables.map((table) => ({
        tableId: table.tableId,
        pageNumber: table.pageNumber,
        canonicalMarkdownStart: table.canonicalMarkdownStart,
        canonicalMarkdownEnd: table.canonicalMarkdownEnd,
      })),
    }))

    const highlightReports = highlights.map((highlight) => {
      const geometry = geometryIndex.get(highlight.sourceScope!.segmentId)
      const tables = geometry?.tables ?? []
      const scopedMatches = resolveTableCellMatches(tables, [highlight], occurrenceIndices)
      const match = scopedMatches.get(highlight) ?? null
      return {
        path: highlight.path.join('.'),
        value: highlight.value,
        snippet: highlight.snippet,
        hintPage: highlight.hintPage,
        rowHeader: highlight.rowHeader,
        columnHeader: highlight.columnHeader,
        sourceScope: highlight.sourceScope,
        ownedTableIds: tables.map((table) => table.tableId),
        matched: match !== null,
        match,
      }
    })

    const report = {
      parsedDocumentPath,
      template: TEMPLATE,
      summary: {
        parsedTables: parsedTables.length,
        linkedTables: linkedTableCount(parsedDocument.tables),
        records: Array.isArray(extraction.result.records) ? extraction.result.records.length : null,
        highlights: highlights.length,
        segments: segmentReports.length,
        highlightsWithOwnedTables: highlightReports.filter((item) => item.ownedTableIds.length > 0).length,
        matchedHighlights: highlightReports.filter((item) => item.matched).length,
        unmatchedHighlights: highlightReports.filter((item) => !item.matched).length,
      },
      segments: segmentReports,
      highlights: highlightReports,
    }

    mkdirSync(outDir, { recursive: true })
    writeFileSync(`${outDir}/schema.json`, JSON.stringify(TEMPLATE, null, 2), 'utf8')
    writeFileSync(`${outDir}/extraction-response.json`, JSON.stringify(extraction, null, 2), 'utf8')
    writeFileSync(`${outDir}/highlight-routing-report.json`, JSON.stringify(report, null, 2), 'utf8')

    console.log(JSON.stringify(report.summary, null, 2))
    console.log(`Wrote diagnostics to ${outDir}`)
  }, 600_000)
})
