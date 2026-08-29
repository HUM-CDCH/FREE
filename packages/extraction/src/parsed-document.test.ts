import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decodeParsedDocument } from './parsed-document.js'

const fixture = {
  schema_version: 'parsed_document.v2',
  document: {
    document_id: 'document-a',
    content_sha256: 'a'.repeat(64),
    source: {
      kind: 'upload',
      original_filename: 'source.pdf',
      media_type: 'application/pdf',
      byte_size: null,
    },
    created_at: 'now',
    page_count: 2,
    language_hints: [],
    is_encrypted: false,
    input_profile: {
      file_kind: 'pdf',
      detected_mime: 'application/pdf',
      pdf_version: null,
      has_text_layer: true,
      has_images: false,
    },
  },
  preprocessing: {
    preprocess_id: 'test',
    profile: 'production_default',
    service_version: null,
    started_at: null,
    finished_at: null,
    status: 'completed',
    warnings: [],
  },
  page_count: 2,
  page_mapping_verified: true,
  artifacts: {
    source_ref: 'source.pdf',
    parsed_json_ref: 'parsed_document.json',
    markdown_ref: 'artifacts/document.llm.md',
  },
  parser_runs: [],
  arbitration: null,
  diagnostics: [],
  content_stream: [
    {
      kind: 'heading',
      block_id: 'b1',
      page_number: 1,
      parser: 'test',
      bbox: null,
      markdown_span: null,
      text: 'First',
      level: 1,
    },
    {
      kind: 'paragraph',
      block_id: 'b2',
      page_number: 1,
      parser: 'test',
      bbox: null,
      markdown_span: null,
      text: 'Body',
    },
    {
      kind: 'heading',
      block_id: 'b3',
      page_number: 2,
      parser: 'test',
      bbox: null,
      markdown_span: null,
      text: 'Second',
      level: 1,
    },
  ],
  pages: [
    {
      page_number: 1,
      width_pt: 100,
      height_pt: 100,
      rotation: 0,
      ordered_content: ['b1', 'b2'],
      unplaced_content: [],
      markdown_span: null,
    },
    {
      page_number: 2,
      width_pt: 100,
      height_pt: 100,
      rotation: 0,
      ordered_content: ['b3'],
      unplaced_content: [],
      markdown_span: null,
    },
  ],
  tables: [],
  evidence_index: { anchors: [] },
}

const orderError = /parsed_document\.v2: content stream order contradicts ordered content/

function copyFixture(): typeof fixture {
  return structuredClone(fixture)
}

describe('parsed_document.v2 canonical order', () => {
  it('accepts content stream order matching ascending physical pages', () => {
    assert.doesNotThrow(() => decodeParsedDocument(copyFixture()))
  })

  it('rejects a same-page ordered-content swap', () => {
    const input = copyFixture()
    input.pages[0].ordered_content = ['b2', 'b1']
    assert.throws(() => decodeParsedDocument(input), orderError)
  })

  it('rejects content stream order crossing physical pages', () => {
    const input = copyFixture()
    input.content_stream = [
      input.content_stream[0],
      input.content_stream[2],
      input.content_stream[1],
    ]
    assert.throws(() => decodeParsedDocument(input), orderError)
  })

  it('rejects reordered pages even when content stream is co-reordered', () => {
    const input = copyFixture()
    input.pages = [input.pages[1], input.pages[0]]
    input.content_stream = [
      input.content_stream[2],
      input.content_stream[0],
      input.content_stream[1],
    ]
    assert.throws(() => decodeParsedDocument(input), orderError)
  })

  it('rejects omitted and duplicated ordered-content IDs', () => {
    const omitted = copyFixture()
    omitted.pages[0].ordered_content = ['b1']
    assert.throws(() => decodeParsedDocument(omitted), orderError)

    const duplicated = copyFixture()
    duplicated.pages[0].ordered_content = ['b1', 'b2', 'b2']
    assert.throws(() => decodeParsedDocument(duplicated), orderError)
  })

  it('accepts an unplaced logical table without a content-stream block', () => {
    const input = copyFixture()
    input.pages[1].unplaced_content = ['table-1']
    input.tables = [
      {
        table_id: 'table-1',
        rows: 0,
        cols: 0,
        cells: [],
        spans: [
          {
            page_number: 2,
            producer_table_ref: null,
            page_local_row_start: 0,
            page_local_row_end: null,
            page_local_col_count: null,
          },
        ],
        parser_attribution: {
          content_parser: { parser: 'test', version: null },
          structure_parser: { parser: 'test', version: null },
          geometry_parser: null,
        },
        continuation: 'page_local',
      },
    ]
    assert.doesNotThrow(() => decodeParsedDocument(input))
  })
})
