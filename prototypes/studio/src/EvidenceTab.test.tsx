// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EvidenceTab from './EvidenceTab'
import { decodeParsedDocument } from 'extraction/parsed-document'

afterEach(cleanup)

const document = decodeParsedDocument({
  schema_version: 'parsed_document.v2',
  document: { document_id: 'document-a', content_sha256: 'a'.repeat(64), source: { kind: 'upload', original_filename: 'source.pdf', media_type: 'application/pdf', byte_size: null }, created_at: 'now', page_count: 1, language_hints: [], is_encrypted: false, input_profile: { file_kind: 'pdf', detected_mime: 'application/pdf', pdf_version: null, has_text_layer: true, has_images: false } },
  preprocessing: { preprocess_id: 'test', profile: 'production_default', service_version: null, started_at: null, finished_at: null, status: 'completed', warnings: [] }, page_count: 1, page_mapping_verified: true, artifacts: { source_ref: 'source.pdf', parsed_json_ref: 'parsed_document.json', markdown_ref: 'artifacts/document.llm.md' }, parser_runs: [], arbitration: null, diagnostics: [{ code: 'ambiguous_table', detail: 'Needs review' }],
  pages: [{ page_number: 1, width_pt: 100, height_pt: 100, rotation: 0, ordered_content: ['b'], unplaced_content: [], markdown_span: null }], content_stream: [{ kind: 'paragraph', block_id: 'b', page_number: 1, parser: 'test', bbox: { x0: 1, y0: 2, x1: 40, y1: 20 }, markdown_span: { start: 21, end: 37 }, text: 'Source paragraph' }], tables: [], evidence_index: { anchors: [{ kind: 'text', anchor_id: 'text-1', content_sha256: 'a'.repeat(64), preprocess_id: 'test', block_id: 'b', markdown_span: { start: 21, end: 37 }, producer_observations: [{ occurrence_id: 'occurrence-1', page_number: 1, producer_ref: '#/texts/1', bbox: { x0: 1, y0: 2, x1: 40, y1: 20 } }] }] },
})

describe('EvidenceTab', () => {
  it('renders one physical page at a time and selects evidence on another page', () => {
    const laterAnchor = { ...document.evidence_index.anchors[0], anchor_id: 'text-2', block_id: 'b2', markdown_span: { start: 38, end: 48 }, producer_observations: [{ ...document.evidence_index.anchors[0].producer_observations[0], occurrence_id: 'occurrence-2', page_number: 2 }] }
    const twoPages = decodeParsedDocument({ ...document,
      document: { ...document.document, page_count: 2 }, page_count: 2,
      pages: [...document.pages, { ...document.pages[0], page_number: 2, ordered_content: ['b2'] }],
      content_stream: [...document.content_stream, { ...document.content_stream[0], block_id: 'b2', page_number: 2, markdown_span: { start: 38, end: 48 }, text: 'Later page' }],
      evidence_index: { anchors: [...document.evidence_index.anchors, laterAnchor] },
    })
    const select = vi.fn()
    render(<EvidenceTab document={twoPages} onSelectAnchor={select} />)
    expect(screen.getAllByRole('button', { name: /^Evidence anchor / })).toHaveLength(1)
    expect(screen.queryByText('Later page')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Evidence page' }), { target: { value: '2' } })
    expect(screen.queryByText('Source paragraph')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Evidence anchor text-2 on page 2' }))
    expect(select).toHaveBeenCalledWith(twoPages.evidence_index.anchors[1])
  })

  it('groups source anchors and displays diagnostics separately from extraction Evidence', () => {
    const html = renderToStaticMarkup(<EvidenceTab document={document} onSelectAnchor={() => undefined} />)
    expect(html).toContain('Physical page 1')
    expect(html).toContain('Source paragraph')
    expect(html).toContain('ambiguous_table')
  })
})
