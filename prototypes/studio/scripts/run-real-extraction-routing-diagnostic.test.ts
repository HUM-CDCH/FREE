import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractWithModel } from '../api/_model.js'
import { buildHighlights, PALETTE } from '../src/evidenceHighlights'
import type { EvidenceSourceScope } from '../src/evidenceHighlights'
import { findScopedMarkdownAnchorMatch } from '../src/markdownAnchorMatch'
import { parseEvidenceAnchors, parseParsedTables } from '../src/parsedDocument'
import type { EvidenceAnchor } from '../src/parsedDocument'
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

function anchorsFullyContainedInScope(
  anchors: readonly EvidenceAnchor[],
  scope: EvidenceSourceScope,
): EvidenceAnchor[] {
  return anchors.filter(
    (anchor) =>
      anchor.markdownStart >= scope.markdownStart &&
      anchor.markdownEnd <= scope.markdownEnd,
  )
}

function occurrenceStarts(markdown: string, term: string, scope: EvidenceSourceScope): number[] {
  const starts: number[] = []
  if (!term) return starts
  let from = scope.markdownStart
  for (;;) {
    const start = markdown.indexOf(term, from)
    const end = start + term.length
    if (start === -1 || end > scope.markdownEnd) break
    starts.push(start)
    from = end
  }
  return starts
}

function anchorsCoveringRange(
  anchors: readonly EvidenceAnchor[],
  start: number,
  end: number,
): EvidenceAnchor[] {
  return anchors.filter((anchor) => anchor.markdownStart < end && anchor.markdownEnd > start)
}

function diagnoseAnchorTerm(
  markdown: string,
  anchors: readonly EvidenceAnchor[],
  term: string | null,
  scope: EvidenceSourceScope,
) {
  if (!term) {
    return {
      term,
      exactOccurrences: 0,
      coveredOccurrences: 0,
      scopeExcludedCoveredOccurrences: 0,
      reason: 'no_term',
    }
  }
  if (anchors.length === 0) {
    return {
      term,
      exactOccurrences: 0,
      coveredOccurrences: 0,
      scopeExcludedCoveredOccurrences: 0,
      reason: 'no_anchors_available',
    }
  }

  const starts = occurrenceStarts(markdown, term, scope)
  const scopedAnchors = anchorsFullyContainedInScope(anchors, scope)
  let coveredOccurrences = 0
  let scopeExcludedCoveredOccurrences = 0
  for (const start of starts) {
    const end = start + term.length
    if (anchorsCoveringRange(scopedAnchors, start, end).length > 0) {
      coveredOccurrences += 1
      continue
    }
    if (anchorsCoveringRange(anchors, start, end).length > 0) {
      scopeExcludedCoveredOccurrences += 1
    }
  }

  let reason = 'anchor_match'
  if (starts.length === 0) {
    reason = 'exact_term_not_found_in_scope'
  } else if (coveredOccurrences === 0 && scopeExcludedCoveredOccurrences > 0) {
    reason = 'only_scope_excluded_anchor_coverage'
  } else if (coveredOccurrences === 0) {
    reason = 'exact_term_has_no_anchor_coverage'
  } else if (coveredOccurrences > 1) {
    reason = 'multiple_scoped_anchor_matches'
  }

  return {
    term,
    exactOccurrences: starts.length,
    coveredOccurrences,
    scopeExcludedCoveredOccurrences,
    reason,
  }
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
    const evidenceIndex = isRecord(parsedDocument.evidence_index) ? parsedDocument.evidence_index : {}
    const parsedAnchors = parseEvidenceAnchors(evidenceIndex.anchors)
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
    const geometryIndex = buildSegmentGeometryIndex(parsedAnchors, parsedTables, sourceScopes)
    const occurrenceIndices = computeOccurrenceIndices(highlights)

    const segmentReports = [...geometryIndex.entries()].map(([segmentId, geometry]) => ({
      segmentId,
      ownedAnchors: geometry.anchors.map((anchor) => ({
        markdownStart: anchor.markdownStart,
        markdownEnd: anchor.markdownEnd,
        page: anchor.page,
      })),
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
      const anchors = geometry?.anchors ?? []
      const scopedMatches = resolveTableCellMatches(tables, [highlight], occurrenceIndices)
      const match = scopedMatches.get(highlight) ?? null
      const primaryTerm =
        highlight.matchStrategy === 'result-primary' ? highlight.value : highlight.snippet
      const fallbackSnippet =
        highlight.matchStrategy === 'result-primary' ? highlight.snippet : null
      const anchorMatch = findScopedMarkdownAnchorMatch(
        markdown,
        anchors,
        primaryTerm,
        fallbackSnippet,
        highlight.sourceScope!,
      )
      const anchorMatched = anchorMatch !== null
      const primaryDiagnosis = diagnoseAnchorTerm(markdown, anchors, primaryTerm, highlight.sourceScope!)
      const fallbackDiagnosis =
        fallbackSnippet && fallbackSnippet !== primaryTerm
          ? diagnoseAnchorTerm(markdown, anchors, fallbackSnippet, highlight.sourceScope!)
          : null
      return {
        path: highlight.path.join('.'),
        value: highlight.value,
        snippet: highlight.snippet,
        hintPage: highlight.hintPage,
        rowHeader: highlight.rowHeader,
        columnHeader: highlight.columnHeader,
        sourceScope: highlight.sourceScope,
        ownedTableIds: tables.map((table) => table.tableId),
        ownedAnchorCount: anchors.length,
        tableMatched: match !== null,
        anchorMatched,
        resolvedBy: match !== null ? 'table' : anchorMatched ? 'anchor' : null,
        anchorDiagnosis: {
          primary: primaryDiagnosis,
          fallback: fallbackDiagnosis,
        },
        matched: match !== null,
        match,
        anchorMatch,
      }
    })

    const report = {
      parsedDocumentPath,
      template: TEMPLATE,
      summary: {
        parsedTables: parsedTables.length,
        linkedTables: linkedTableCount(parsedDocument.tables),
        parsedAnchors: parsedAnchors.length,
        records: Array.isArray(extraction.result.records) ? extraction.result.records.length : null,
        highlights: highlights.length,
        segments: segmentReports.length,
        highlightsWithOwnedTables: highlightReports.filter((item) => item.ownedTableIds.length > 0).length,
        highlightsWithOwnedAnchors: highlightReports.filter((item) => item.ownedAnchorCount > 0).length,
        tableMatchedHighlights: highlightReports.filter((item) => item.tableMatched).length,
        anchorMatchedHighlights: highlightReports.filter((item) => item.anchorMatched).length,
        resolvedHighlights: highlightReports.filter((item) => item.resolvedBy !== null).length,
        unresolvedHighlights: highlightReports.filter((item) => item.resolvedBy === null).length,
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
