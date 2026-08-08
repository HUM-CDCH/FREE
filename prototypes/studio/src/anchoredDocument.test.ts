import { describe, expect, it } from 'vitest'
import bundled from './assets/parsed_document.v2.json'
import { decodeParsedDocument, type ParsedDocumentV2 } from './parsedDocument'
import { anchoredSource, canonicalSource } from './anchoredDocument'

describe('anchoredSource', () => {
  it('labels every canonical passage the model may cite', () => {
    const document = decodeParsedDocument(bundled)
    const { text, anchorIdByLabel } = anchoredSource(document)

    expect(text).toContain('## Page 1')
    expect([...anchorIdByLabel.values()]).toEqual(
      document.evidence_index.anchors.map((anchor) => anchor.anchor_id),
    )
    for (const label of anchorIdByLabel.keys()) expect(text).toContain(`[${label}]`)
    // Nothing else about the Evidence reaches the model.
    expect(text).not.toMatch(/occurrence_id|bbox|content_sha256/)
    expect(canonicalSource(document)).not.toMatch(/\[E\d+\]/)
  })

  it('renders a continued logical table only at its first occurrence', () => {
    const document = decodeParsedDocument(bundled)
    const tableId = 'continued-table'
    const anchorId = 'continued-cell-anchor'
    const continued: ParsedDocumentV2 = {
      ...document,
      pages: document.pages.map((page) =>
        page.page_number <= 2
          ? { ...page, unplaced_content: [...page.unplaced_content, tableId] }
          : page,
      ),
      tables: [
        {
          table_id: tableId,
          rows: 1,
          cols: 1,
          cells: [
            {
              cell_id: 'continued-cell',
              row: 0,
              column: 0,
              text: '24-1',
              role: null,
              rowspan: 1,
              colspan: 1,
              bbox: null,
              evidence_anchor_id: anchorId,
            },
          ],
          spans: [1, 2].map((pageNumber) => ({
            page_number: pageNumber,
            producer_table_ref: `table-page-${pageNumber}`,
            page_local_row_start: 0,
            page_local_row_end: 1,
            page_local_col_count: 1,
          })),
          parser_attribution: {
            content_parser: { parser: 'fixture', version: null },
            structure_parser: { parser: 'fixture', version: null },
            geometry_parser: { parser: 'fixture', version: null },
          },
          continuation: 'derived_continuation',
        },
      ],
      evidence_index: {
        anchors: [
          ...document.evidence_index.anchors,
          {
            kind: 'table_cell',
            anchor_id: anchorId,
            content_sha256: document.document.content_sha256,
            preprocess_id: document.preprocessing.preprocess_id,
            logical_table_id: tableId,
            cell_id: 'continued-cell',
            canonical_row: 0,
            canonical_column: 0,
            producer_observations: [1, 2].map((pageNumber) => ({
              occurrence_id: `continued-occurrence-${pageNumber}`,
              page_number: pageNumber,
              producer_ref: `table-page-${pageNumber}`,
              row_offset: 0,
              column_offset: 0,
              row_span: 1,
              column_span: 1,
              bbox: { x0: 1, y0: 1, x1: 10, y1: 10 },
            })),
          },
        ],
      },
    }

    const { text, anchorIdByLabel } = anchoredSource(continued)
    const headings = text.match(
      new RegExp(`^### Table ${tableId}$`, 'gm'),
    )

    expect(headings).toHaveLength(1)
    expect(new Set(anchorIdByLabel.values()).size).toBe(anchorIdByLabel.size)
    expect([...anchorIdByLabel.values()]).toContain(anchorId)
  })
})
