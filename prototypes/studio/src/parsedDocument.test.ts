import { describe, expect, it } from 'vitest'
import { decodeParsedDocument, diagnosticsFor } from './parsedDocument'

const sha = 'a'.repeat(64)
const fixture = {
  schema_version: 'parsed_document.v2',
  document: { document_id: 'document-a', content_sha256: sha, source: { kind: 'upload', original_filename: 'source.pdf', media_type: 'application/pdf', byte_size: null }, created_at: 'now', page_count: 2, language_hints: [], is_encrypted: false, input_profile: { file_kind: 'pdf', detected_mime: 'application/pdf', pdf_version: null, has_text_layer: true, has_images: false } },
  preprocessing: { preprocess_id: 'test', profile: 'production_default', service_version: null, started_at: null, finished_at: null, status: 'completed', warnings: [] },
  page_count: 2, page_mapping_verified: true, artifacts: { source_ref: 'source.pdf', parsed_json_ref: 'parsed_document.json', markdown_ref: 'artifacts/document.llm.md' }, parser_runs: [], arbitration: null, diagnostics: [{ code: 'unplaced_table' }],
  pages: [{ page_number: 1, width_pt: null, height_pt: null, rotation: 0, ordered_content: ['b1'], unplaced_content: [], markdown_span: null }, { page_number: 2, width_pt: null, height_pt: null, rotation: 0, ordered_content: [], unplaced_content: ['t1'], markdown_span: null }],
  content_stream: [{ kind: 'paragraph', block_id: 'b1', page_number: 1, parser: 'test', bbox: null, markdown_span: { start: 21, end: 25 }, text: 'Text' }],
  tables: [{ table_id: 't1', continuation: 'derived_continuation', rows: 1, cols: 1, cells: [{ cell_id: 'c1', row: 0, column: 0, text: 'Cell', role: 'data', rowspan: 1, colspan: 1, bbox: null, evidence_anchor_id: 'a2' }], spans: [{ page_number: 2, producer_table_ref: '#/tables/1', page_local_row_start: 0, page_local_row_end: 0, page_local_col_count: 1 }], parser_attribution: { content_parser: { parser: 'docling', version: null }, structure_parser: { parser: 'docling', version: null }, geometry_parser: null } }],
  evidence_index: { anchors: [{ kind: 'text', anchor_id: 'a1', occurrence_id: 'o1', content_sha256: sha, preprocess_id: 'test', block_id: 'b1', page_number: 1, markdown_span: { start: 21, end: 25 }, bbox: null }, { kind: 'table_cell', anchor_id: 'a2', content_sha256: sha, preprocess_id: 'test', logical_table_id: 't1', cell_id: 'c1', canonical_row: 0, canonical_column: 0, producer_observations: [{ occurrence_id: 'o2', page_number: 2, row_offset: 0, column_offset: 0, row_span: 1, column_span: 1, producer_ref: '#/tables/1', bbox: null }] }] },
}

describe('parsed_document.v2 decoder', () => {
  it('decodes the one canonical shape and typed diagnostics', () => {
    const document = decodeParsedDocument(fixture)
    expect(document.content_stream[0].kind).toBe('paragraph')
    expect(diagnosticsFor(document)).toEqual([{ code: 'unplaced_table' }])
  })

  it('rejects removed aliases and v1 payloads', () => {
    expect(() => decodeParsedDocument({ ...fixture, schema_version: 'parsed_document.v1' })).toThrow()
    expect(() => decodeParsedDocument({ ...fixture, blocks: fixture.content_stream })).toThrow()
    expect(() => decodeParsedDocument({ ...fixture, content_stream: [{ ...fixture.content_stream[0], char_span: fixture.content_stream[0].markdown_span }] })).toThrow()
    expect(() => decodeParsedDocument({ ...fixture, tables: [{ ...fixture.tables[0], cells: [{ ...fixture.tables[0].cells[0], col: 0 }] }] })).toThrow()
  })
})
