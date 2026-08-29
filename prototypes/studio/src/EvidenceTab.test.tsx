import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import EvidenceTab from './EvidenceTab'
import { decodeParsedDocument } from 'extraction/parsed-document'

const document = decodeParsedDocument({
  schema_version: 'parsed_document.v2',
  document: { document_id: 'document-a', content_sha256: 'a'.repeat(64), source: { kind: 'upload', original_filename: 'source.pdf', media_type: 'application/pdf', byte_size: null }, created_at: 'now', page_count: 1, language_hints: [], is_encrypted: false, input_profile: { file_kind: 'pdf', detected_mime: 'application/pdf', pdf_version: null, has_text_layer: true, has_images: false } },
  preprocessing: { preprocess_id: 'test', profile: 'production_default', service_version: null, started_at: null, finished_at: null, status: 'completed', warnings: [] }, page_count: 1, page_mapping_verified: true, artifacts: { source_ref: 'source.pdf', parsed_json_ref: 'parsed_document.json', markdown_ref: 'artifacts/document.llm.md' }, parser_runs: [], arbitration: null, diagnostics: [{ code: 'ambiguous_table', detail: 'Needs review' }],
  pages: [{ page_number: 1, width_pt: 100, height_pt: 100, rotation: 0, ordered_content: ['b'], unplaced_content: [], markdown_span: null }], content_stream: [{ kind: 'paragraph', block_id: 'b', page_number: 1, parser: 'test', bbox: { x0: 1, y0: 2, x1: 40, y1: 20 }, markdown_span: { start: 21, end: 37 }, text: 'Source paragraph' }], tables: [], evidence_index: { anchors: [{ kind: 'text', anchor_id: 'text-1', content_sha256: 'a'.repeat(64), preprocess_id: 'test', block_id: 'b', markdown_span: { start: 21, end: 37 }, producer_observations: [{ occurrence_id: 'occurrence-1', page_number: 1, producer_ref: '#/texts/1', bbox: { x0: 1, y0: 2, x1: 40, y1: 20 } }] }] },
})

describe('EvidenceTab', () => {
  it('groups source anchors and displays diagnostics separately from extraction Evidence', () => {
    const html = renderToStaticMarkup(<EvidenceTab document={document} onSelectAnchor={() => undefined} />)
    expect(html).toContain('Physical page 1')
    expect(html).toContain('Source paragraph')
    expect(html).toContain('ambiguous_table')
  })
})
