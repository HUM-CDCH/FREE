import { z } from 'zod'
import { ExtractionError } from './errors.js'

const byteSpanSchema = z.object({ start: z.int().nonnegative(), end: z.int().nonnegative() }).strict().refine((value) => value.end >= value.start, 'span end must not precede start')
const bboxSchema = z.object({ x0: z.number().finite(), y0: z.number().finite(), x1: z.number().finite(), y1: z.number().finite() }).strict().refine((value) => value.x1 > value.x0 && value.y1 > value.y0, 'bbox must have positive area')
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
const textObservationSchema = z.object({ occurrence_id: z.string().min(1), page_number: z.int().positive(), producer_ref: z.string().nullable(), bbox: bboxSchema }).strict()
const observationSchema = z.object({ occurrence_id: z.string().min(1), page_number: z.int().positive(), producer_ref: z.string().nullable(), row_offset: z.int().nonnegative(), column_offset: z.int().nonnegative(), row_span: z.int().positive(), column_span: z.int().positive(), bbox: bboxSchema }).strict()
const textAnchorSchema = z.object({ kind: z.literal('text'), anchor_id: z.string().min(1), content_sha256: z.string().regex(/^[a-f0-9]{64}$/), preprocess_id: z.string().min(1), block_id: z.string().min(1), markdown_span: byteSpanSchema, producer_observations: z.array(textObservationSchema).min(1) }).strict()
const tableAnchorSchema = z.object({ kind: z.literal('table_cell'), anchor_id: z.string().min(1), content_sha256: z.string().regex(/^[a-f0-9]{64}$/), preprocess_id: z.string().min(1), logical_table_id: z.string().min(1), cell_id: z.string().min(1), canonical_row: z.int().nonnegative(), canonical_column: z.int().nonnegative(), producer_observations: z.array(observationSchema).min(1) }).strict()
const anchorSchema = z.discriminatedUnion('kind', [textAnchorSchema, tableAnchorSchema])
const cellSchema = z.object({ cell_id: z.string().min(1), row: z.int().nonnegative(), column: z.int().nonnegative(), text: z.string(), role: z.string().nullable(), rowspan: z.int().positive(), colspan: z.int().positive(), bbox: bboxSchema.nullable(), evidence_anchor_id: z.string().min(1) }).strict()
const spanSchema = z.object({ page_number: z.int().positive(), producer_table_ref: z.string().nullable(), page_local_row_start: z.int().nonnegative(), page_local_row_end: z.int().nonnegative().nullable(), page_local_col_count: z.int().nonnegative().nullable() }).strict()
const attributionSchema = z.object({ content_parser: z.object({ parser: z.string(), version: z.string().nullable() }).strict(), structure_parser: z.object({ parser: z.string(), version: z.string().nullable() }).strict(), geometry_parser: z.object({ parser: z.string(), version: z.string().nullable() }).strict().nullable() }).strict()
const tableSchema = z.object({ table_id: z.string().min(1), rows: z.int().nonnegative().nullable(), cols: z.int().nonnegative().nullable(), cells: z.array(cellSchema), spans: z.array(spanSchema).min(1), parser_attribution: attributionSchema, continuation: z.enum(['page_local', 'derived_continuation']) }).strict()
const pageSchema = z.object({ page_number: z.int().positive(), width_pt: z.number().finite().positive(), height_pt: z.number().finite().positive(), rotation: z.number().int().refine((value) => value % 90 === 0, 'rotation must be a multiple of 90 degrees'), ordered_content: z.array(z.string()), unplaced_content: z.array(z.string()), markdown_span: byteSpanSchema.nullable() }).strict()
const parserRunSchema = z.object({ parser: z.string(), version: z.string().nullable(), status: z.enum(['success', 'failed', 'skipped']), warnings: z.array(z.string()), error: z.string().nullable() }).strict()
const artifactSchema = z.object({ source_ref: z.literal('source.pdf'), parsed_json_ref: z.literal('parsed_document.json'), markdown_ref: z.literal('artifacts/document.llm.md') }).strict()

const parsedDocumentSchema = z.object({
  schema_version: z.literal('parsed_document.v2'), document: documentSchema, preprocessing: preprocessingSchema, page_count: z.int().positive(), page_mapping_verified: z.literal(true),
  artifacts: artifactSchema, parser_runs: z.array(parserRunSchema), arbitration: z.record(z.string(), z.unknown()).nullable(), diagnostics: z.array(diagnosticSchema), content_stream: z.array(blockSchema), pages: z.array(pageSchema), tables: z.array(tableSchema), evidence_index: z.object({ anchors: z.array(anchorSchema) }).strict(),
}).strict()

export type MarkdownSpan = z.infer<typeof byteSpanSchema>
export type ParsedDocumentPage = z.infer<typeof pageSchema>
export type ParsedContentBlock = z.infer<typeof blockSchema>
export type TextEvidenceAnchor = z.infer<typeof textAnchorSchema>
export type TextProducerObservation = z.infer<typeof textObservationSchema>
export type ProducerObservation = z.infer<typeof observationSchema>
export type TableCellEvidenceAnchor = z.infer<typeof tableAnchorSchema>
export type ParsedEvidenceAnchor = z.infer<typeof anchorSchema>
export type ParsedLogicalTable = z.infer<typeof tableSchema>
export type ParsedDocument = z.infer<typeof parsedDocumentSchema>

export function decodeParsedDocument(data: unknown): ParsedDocument {
  const parsed = parsedDocumentSchema.parse(data)
  const pages = new Map(parsed.pages.map((page) => [page.page_number, page]))
  if (pages.size !== parsed.page_count || [...pages.keys()].some((page) => page < 1 || page > parsed.page_count)) throw new Error('parsed_document.v2: pages must uniquely cover all physical pages')
  const blocks = new Map(parsed.content_stream.map((block) => [block.block_id, block]))
  if (blocks.size !== parsed.content_stream.length) throw new Error('parsed_document.v2: content block IDs must be unique')
  const tables = new Map(parsed.tables.map((table) => [table.table_id, table]))
  if (tables.size !== parsed.tables.length) throw new Error('parsed_document.v2: table IDs must be unique')
  const anchors = new Map(parsed.evidence_index.anchors.map((anchor) => [anchor.anchor_id, anchor]))
  if (anchors.size !== parsed.evidence_index.anchors.length) throw new Error('parsed_document.v2: evidence anchor IDs must be unique')
  const occurrenceIds = new Set<string>()
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
  const orderedBlockIds = parsed.pages.flatMap((page) => page.ordered_content)
  if (
    parsed.pages.some((page, index) => page.page_number !== index + 1) ||
    orderedBlockIds.length !== parsed.content_stream.length ||
    orderedBlockIds.some(
      (blockId, index) => blockId !== parsed.content_stream[index].block_id,
    )
  )
    throw new Error(
      'parsed_document.v2: content stream order contradicts ordered content',
    )
  if (placed.size !== tables.size) throw new Error('parsed_document.v2: every table requires a placement')
  for (const anchor of parsed.evidence_index.anchors) {
    if (anchor.content_sha256 !== parsed.document.content_sha256 || anchor.preprocess_id !== parsed.preprocessing.preprocess_id) throw new Error('parsed_document.v2: evidence identity does not match document')
    const occurrences = anchor.producer_observations
    for (const occurrence of occurrences) {
      if (occurrenceIds.has(occurrence.occurrence_id)) throw new Error('parsed_document.v2: evidence occurrence IDs must be unique')
      const page = pages.get(occurrence.page_number)
      if (!page) throw new Error('parsed_document.v2: evidence page is invalid')
      const { bbox } = occurrence
      if (bbox.x0 < 0 || bbox.y0 < 0 || bbox.x1 > page.width_pt || bbox.y1 > page.height_pt) throw new Error('parsed_document.v2: evidence bbox is outside its physical page')
      occurrenceIds.add(occurrence.occurrence_id)
    }
    if (anchor.kind === 'text') {
      const block = blocks.get(anchor.block_id)
      const first = anchor.producer_observations[0]
      if (!block || block.page_number !== first.page_number || block.markdown_span?.start !== anchor.markdown_span.start || block.markdown_span?.end !== anchor.markdown_span.end || !block.bbox || block.bbox.x0 !== first.bbox.x0 || block.bbox.y0 !== first.bbox.y0 || block.bbox.x1 !== first.bbox.x1 || block.bbox.y1 !== first.bbox.y1) throw new Error('parsed_document.v2: text evidence reference is invalid')
    } else {
      const table = tables.get(anchor.logical_table_id)
      const cell = table?.cells.find((candidate) => candidate.cell_id === anchor.cell_id)
      if (!table || !cell || cell.evidence_anchor_id !== anchor.anchor_id || cell.row !== anchor.canonical_row || cell.column !== anchor.canonical_column) throw new Error('parsed_document.v2: table evidence reference is invalid')
      // Mirrors the Python authority exactly: an occurrence must resolve to one
      // page span, and a bounded span constrains the row offset from both ends.
      for (const observation of anchor.producer_observations) {
        const spans = table.spans.filter((span) => span.page_number === observation.page_number && (span.producer_table_ref === null || span.producer_table_ref === observation.producer_ref) && (span.page_local_row_end === null || (span.page_local_row_start <= observation.row_offset && observation.row_offset <= span.page_local_row_end)))
        if (spans.length !== 1) throw new Error('parsed_document.v2: table evidence occurrence must resolve to one page span')
      }
    }
  }
  for (const table of parsed.tables) for (const cell of table.cells) if (anchors.get(cell.evidence_anchor_id)?.kind !== 'table_cell') throw new Error('parsed_document.v2: every table cell requires one evidence anchor')
  return parsed
}

/** A pinned Source Representation's package, or `invalid_source_representation` when it is not a ParsedDocument v2. */
export function decodePinnedDocument(raw: unknown): ParsedDocument {
  try { return decodeParsedDocument(raw) }
  catch (error) { throw new ExtractionError('invalid_source_representation', 'The pinned Source Representation is not a valid ParsedDocument v2.', { cause: error }) }
}

export function tableForAnchor(document: ParsedDocument, anchor: TableCellEvidenceAnchor): ParsedLogicalTable | undefined { return document.tables.find((table) => table.table_id === anchor.logical_table_id) }
export function blockForAnchor(document: ParsedDocument, anchor: TextEvidenceAnchor): ParsedContentBlock | undefined { return document.content_stream.find((block) => block.block_id === anchor.block_id) }
