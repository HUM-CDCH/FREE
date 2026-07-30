import { z } from 'zod'

const byteSpanSchema = z.object({ start: z.int().nonnegative(), end: z.int().nonnegative() }).strict().refine((value) => value.end >= value.start, 'span end must not precede start')
const bboxSchema = z.object({ x0: z.number().finite(), y0: z.number().finite(), x1: z.number().finite(), y1: z.number().finite() }).strict().refine((value) => value.x1 >= value.x0 && value.y1 >= value.y0, 'bbox coordinates must be ordered')
const sourceSchema = z.object({ kind: z.literal('upload'), original_filename: z.string().nullable(), media_type: z.literal('application/pdf'), byte_size: z.number().int().nonnegative().nullable() }).strict()
const documentSchema = z.object({
  document_id: z.string().min(1), content_sha256: z.string().regex(/^[a-f0-9]{64}$/), source: sourceSchema,
  created_at: z.string(), page_count: z.number().int().nonnegative().nullable(), language_hints: z.array(z.string()),
  is_encrypted: z.boolean().nullable(), input_profile: z.object({ file_kind: z.literal('pdf'), detected_mime: z.string(), pdf_version: z.string().nullable(), has_text_layer: z.boolean().nullable(), has_images: z.boolean().nullable() }).strict(),
}).strict()
const preprocessingSchema = z.object({ preprocess_id: z.string().min(1), profile: z.string(), service_version: z.string().nullable(), started_at: z.string().nullable(), finished_at: z.string().nullable(), status: z.enum(['completed', 'completed_with_warnings', 'failed']), warnings: z.array(z.string()) }).strict()
const diagnosticSchema = z.object({ code: z.string().min(1), reason: z.string().nullable().optional(), detail: z.string().nullable().optional(), page_number: z.int().positive().nullable().optional() }).passthrough()
const commonBlock = { block_id: z.string().min(1), page_number: z.int().positive(), parser: z.string().min(1), bbox: bboxSchema.nullable(), markdown_span: byteSpanSchema.nullable() }
const blockSchema = z.discriminatedUnion('kind', [
  z.object({ ...commonBlock, kind: z.literal('heading'), text: z.string(), level: z.int().positive() }).strict(),
  z.object({ ...commonBlock, kind: z.literal('paragraph'), text: z.string() }).strict(),
  z.object({ ...commonBlock, kind: z.literal('text'), text: z.string() }).strict(),
  z.object({ ...commonBlock, kind: z.literal('list'), ordered: z.boolean(), items: z.array(z.string()).min(1) }).strict(),
  z.object({ ...commonBlock, kind: z.literal('code'), text: z.string(), language: z.string().nullable() }).strict(),
  z.object({ ...commonBlock, kind: z.literal('formula'), text: z.string() }).strict(),
  z.object({ ...commonBlock, kind: z.literal('caption'), text: z.string() }).strict(),
  z.object({ ...commonBlock, kind: z.literal('table'), table_id: z.string().min(1) }).strict(),
  z.object({ ...commonBlock, kind: z.literal('page_break'), next_page: z.int().positive() }).strict(),
])
const observationSchema = z.object({ page_number: z.int().positive(), producer_ref: z.string().nullable(), row_offset: z.int().nonnegative(), column_offset: z.int().nonnegative(), row_span: z.int().positive(), column_span: z.int().positive(), bbox: bboxSchema.nullable() }).strict()
const textAnchorSchema = z.object({ kind: z.literal('text'), anchor_id: z.string().min(1), content_sha256: z.string().regex(/^[a-f0-9]{64}$/), preprocess_id: z.string().min(1), block_id: z.string().min(1), page_number: z.int().positive(), markdown_span: byteSpanSchema, bbox: bboxSchema.nullable() }).strict()
const tableAnchorSchema = z.object({ kind: z.literal('table_cell'), anchor_id: z.string().min(1), content_sha256: z.string().regex(/^[a-f0-9]{64}$/), preprocess_id: z.string().min(1), logical_table_id: z.string().min(1), cell_id: z.string().min(1), canonical_row: z.int().nonnegative(), canonical_column: z.int().nonnegative(), producer_observation: observationSchema }).strict()
const anchorSchema = z.discriminatedUnion('kind', [textAnchorSchema, tableAnchorSchema])
const cellSchema = z.object({ cell_id: z.string().min(1), row: z.int().nonnegative(), column: z.int().nonnegative(), text: z.string(), role: z.string().nullable(), rowspan: z.int().positive(), colspan: z.int().positive(), bbox: bboxSchema.nullable(), evidence_anchor_id: z.string().min(1) }).strict()
const spanSchema = z.object({ page_number: z.int().positive(), producer_table_ref: z.string().nullable(), page_local_row_start: z.int().nonnegative(), page_local_row_end: z.int().nonnegative().nullable(), page_local_col_count: z.int().nonnegative().nullable() }).strict()
const attributionSchema = z.object({ content_parser: z.object({ parser: z.string(), version: z.string().nullable() }).strict(), structure_parser: z.object({ parser: z.string(), version: z.string().nullable() }).strict(), geometry_parser: z.object({ parser: z.string(), version: z.string().nullable() }).strict().nullable() }).strict()
const tableSchema = z.object({ table_id: z.string().min(1), rows: z.int().nonnegative().nullable(), cols: z.int().nonnegative().nullable(), cells: z.array(cellSchema), spans: z.array(spanSchema).min(1), parser_attribution: attributionSchema, continuation: z.enum(['page_local', 'derived_continuation']) }).strict()
const pageSchema = z.object({ page_number: z.int().positive(), width_pt: z.number().nonnegative().nullable(), height_pt: z.number().nonnegative().nullable(), rotation: z.number().int().nullable(), ordered_content: z.array(z.string()), unplaced_content: z.array(z.string()), markdown_span: byteSpanSchema.nullable() }).strict()
const parserRunSchema = z.object({ parser: z.string(), version: z.string().nullable(), status: z.enum(['success', 'failed', 'skipped']), warnings: z.array(z.string()), error: z.string().nullable() }).strict()
const artifactSchema = z.object({ source_ref: z.literal('source.pdf'), parsed_json_ref: z.literal('parsed_document.json'), markdown_ref: z.literal('artifacts/document.llm.md') }).strict()

const parsedDocumentSchema = z.object({
  schema_version: z.literal('parsed_document.v2'), document: documentSchema, preprocessing: preprocessingSchema, page_count: z.int().positive(), page_mapping_verified: z.literal(true),
  artifacts: artifactSchema, parser_runs: z.array(parserRunSchema), arbitration: z.record(z.string(), z.unknown()).nullable(), diagnostics: z.array(diagnosticSchema), content_stream: z.array(blockSchema), pages: z.array(pageSchema), tables: z.array(tableSchema), evidence_index: z.object({ anchors: z.array(anchorSchema) }).strict(),
}).strict()

export type JsonObject = Record<string, unknown>
export type MarkdownSpan = z.infer<typeof byteSpanSchema>
export type ParsedDocumentPage = z.infer<typeof pageSchema>
export type ParsedContentBlock = z.infer<typeof blockSchema>
export type TextEvidenceAnchor = z.infer<typeof textAnchorSchema>
export type ProducerObservation = z.infer<typeof observationSchema>
export type TableCellEvidenceAnchor = z.infer<typeof tableAnchorSchema>
export type ParsedEvidenceAnchor = z.infer<typeof anchorSchema>
export type ParsedLogicalTable = z.infer<typeof tableSchema>
export type ParsedDocumentV2 = z.infer<typeof parsedDocumentSchema>

export function decodeParsedDocument(data: unknown): ParsedDocumentV2 {
  const parsed = parsedDocumentSchema.parse(data)
  const pages = new Set(parsed.pages.map((page) => page.page_number))
  if (pages.size !== parsed.page_count || [...pages].some((page) => page < 1 || page > parsed.page_count)) throw new Error('parsed_document.v2: pages must uniquely cover all physical pages')
  const blocks = new Map(parsed.content_stream.map((block) => [block.block_id, block]))
  if (blocks.size !== parsed.content_stream.length) throw new Error('parsed_document.v2: content block IDs must be unique')
  const tables = new Map(parsed.tables.map((table) => [table.table_id, table]))
  if (tables.size !== parsed.tables.length) throw new Error('parsed_document.v2: table IDs must be unique')
  const anchors = new Map(parsed.evidence_index.anchors.map((anchor) => [anchor.anchor_id, anchor]))
  if (anchors.size !== parsed.evidence_index.anchors.length) throw new Error('parsed_document.v2: evidence anchor IDs must be unique')
  const placed = new Set<string>()
  for (const page of parsed.pages) {
    for (const blockId of page.ordered_content) {
      const block = blocks.get(blockId)
      if (!block || block.page_number !== page.page_number) throw new Error('parsed_document.v2: ordered content reference is invalid')
      if (block.kind === 'table') { if (!tables.has(block.table_id)) throw new Error('parsed_document.v2: table block reference is invalid'); placed.add(block.table_id) }
    }
    for (const tableId of page.unplaced_content) {
      const table = tables.get(tableId)
      if (!table || !table.spans.some((span) => span.page_number === page.page_number)) throw new Error('parsed_document.v2: unplaced table reference is invalid')
      placed.add(tableId)
    }
  }
  if (placed.size !== tables.size) throw new Error('parsed_document.v2: every table requires a placement')
  for (const anchor of parsed.evidence_index.anchors) {
    if (anchor.content_sha256 !== parsed.document.content_sha256 || anchor.preprocess_id !== parsed.preprocessing.preprocess_id) throw new Error('parsed_document.v2: evidence identity does not match document')
    const page = anchor.kind === 'text' ? anchor.page_number : anchor.producer_observation.page_number
    if (!pages.has(page)) throw new Error('parsed_document.v2: evidence page is invalid')
    if (anchor.kind === 'text') {
      const block = blocks.get(anchor.block_id)
      if (!block || block.page_number !== page || block.markdown_span?.start !== anchor.markdown_span.start || block.markdown_span?.end !== anchor.markdown_span.end) throw new Error('parsed_document.v2: text evidence reference is invalid')
    } else {
      const table = tables.get(anchor.logical_table_id)
      const cell = table?.cells.find((candidate) => candidate.cell_id === anchor.cell_id)
      if (!table || !cell || cell.evidence_anchor_id !== anchor.anchor_id || cell.row !== anchor.canonical_row || cell.column !== anchor.canonical_column) throw new Error('parsed_document.v2: table evidence reference is invalid')
      if (!table.spans.some((span) => span.page_number === page && (span.producer_table_ref === null || span.producer_table_ref === anchor.producer_observation.producer_ref) && (span.page_local_row_end === null || anchor.producer_observation.row_offset <= span.page_local_row_end))) throw new Error('parsed_document.v2: table evidence has no matching page span')
    }
  }
  for (const table of parsed.tables) for (const cell of table.cells) if (anchors.get(cell.evidence_anchor_id)?.kind !== 'table_cell') throw new Error('parsed_document.v2: every table cell requires one evidence anchor')
  return parsed
}

export function anchorPage(anchor: ParsedEvidenceAnchor): number { return anchor.kind === 'text' ? anchor.page_number : anchor.producer_observation.page_number }
export function tableForAnchor(document: ParsedDocumentV2, anchor: TableCellEvidenceAnchor): ParsedLogicalTable | undefined { return document.tables.find((table) => table.table_id === anchor.logical_table_id) }
export function blockForAnchor(document: ParsedDocumentV2, anchor: TextEvidenceAnchor): ParsedContentBlock | undefined { return document.content_stream.find((block) => block.block_id === anchor.block_id) }
export function diagnosticsFor(document: ParsedDocumentV2): JsonObject[] { return document.diagnostics as JsonObject[] }
