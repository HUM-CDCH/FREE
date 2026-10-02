/**
 * The kei-exp adapter: one run's accepted result (its manifest and page files,
 * `src/kei_exp/pagefile.py` in kei-exp) translated once into
 * `parsed_document.v2` plus the package Markdown its byte spans index.
 *
 * Physical PDF page numbers, top-left PDF-point geometry and the source
 * SHA-256 pass through unchanged. Markdown byte spans are computed while the
 * Markdown is rendered, never recovered by search. Native cells retain their
 * measured geometry; tables without cell geometry keep a coarse anchor.
 *
 * Identities are functions of the kei-exp segment identity `p{page}_s{index}`
 * (the physical PDF page and the 0-based index of the segment in that page
 * file's `segments`), which kei-exp's extraction evidence will also name:
 * block `b_p{page}_s{index}`, anchor `a_p{page}_s{index}`, occurrence
 * `o_p{page}_s{index}`. A segment without a block (error, skipped, an empty
 * figure) leaves its index unused, so the index keeps its meaning.
 *
 * Two departures from the agreed mapping table: a list segment's non-empty
 * lines become one item each (Surya's `ListGroup` carries a whole list), and
 * `Footnote` maps to `caption` as the previous parser did.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  decodeParsedDocument,
  type MarkdownSpan,
  type ParsedContentBlock,
  type ParsedDocument,
  type ParsedDocumentPage,
  type ParsedEvidenceAnchor,
  type ParsedLogicalTable,
} from 'extraction/parsed-document'

export const PARSER_NAME = 'kei-exp'
/** A page edge moved by more than this while clamping is worth a diagnostic. */
const CLAMP_TOLERANCE_PT = 0.5

const pointBoxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])
const tableSchema = z
  .object({
    rows: z.int().nonnegative(),
    columns: z.int().nonnegative(),
    producer: z.string().min(1),
    cells: z.array(
      z
        .object({
          cell_id: z.string().regex(/^r\d+_c\d+$/),
          row: z.int().nonnegative(),
          column: z.int().nonnegative(),
          rowspan: z.int().positive(),
          colspan: z.int().positive(),
          role: z.string().nullable(),
          text: z.string(),
          start: z.int().nonnegative(),
          end: z.int().nonnegative(),
          bbox_pt: pointBoxSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict()
const segmentSchema = z
  .object({
    text: z.string(),
    html: z.string().nullable(),
    label: z.string(),
    status: z.enum(['ok', 'error', 'skipped']),
    crop: z.int().nullable(),
    bbox_pt: pointBoxSchema,
    extent: z.enum(['block', 'input']),
    table: tableSchema.nullable().optional(),
  })
  .loose()
export const keiExpPageSchema = z
  .object({
    generation: z.string().min(1),
    page: z.int().positive(),
    size_pt: z.tuple([z.number().positive(), z.number().positive()]),
    segments: z.array(segmentSchema),
    complete: z.boolean(),
    warnings: z.array(z.string()),
  })
  .loose()
export const keiExpManifestSchema = z
  .object({
    result_version: z.literal(5),
    generation: z.string().min(1),
    recipe: z
      .object({
        source_sha256: z.string(),
        transcriber: z.string().min(1),
        model: z.string().nullable().optional(),
        // The model record: a Docling VLM record names its spec, a Surya record none.
        record: z.object({ spec: z.string().nullable().optional() }).loose().nullable().optional(),
        versions: z.record(z.string(), z.string()).optional(),
      })
      .loose(),
    page_count: z.int().positive(),
    started: z.string().nullable(),
    seconds: z.number().nullable(),
    status: z.enum(['success', 'incomplete']),
    incomplete: z.string().nullable(),
    pages: z.record(
      z.string(),
      z.object({ sha256: z.string(), complete: z.boolean() }).loose(),
    ),
  })
  .loose()

export type KeiExpSegment = z.infer<typeof segmentSchema>
export type KeiExpPage = z.infer<typeof keiExpPageSchema>
export type KeiExpManifest = z.infer<typeof keiExpManifestSchema>
export type KeiExpSource = {
  sha256: string
  originalFilename: string
  byteSize: number
}
export type TranslatedDocument = {
  document: ParsedDocument
  markdown: Uint8Array
}

type Bbox = NonNullable<ParsedContentBlock['bbox']>
type Diagnostic = ParsedDocument['diagnostics'][number]
type Kind =
  | 'heading'
  | 'list'
  | 'caption'
  | 'formula'
  | 'code'
  | 'table'
  | 'figure'
  | 'paragraph'
type Draft = { block: ParsedContentBlock
  producerRef: string
  table?: KeiExpSegment['table']
  tableText?: string }
type DraftPage = { page: KeiExpPage; drafts: Draft[] }
type RenderedPage = {
  page: KeiExpPage
  span: MarkdownSpan | null
  blocks: Draft[]
}

/** Surya's public label names, kei-exp's native `text`, and older spellings, folded to letters. */
const KIND_OF_LABEL: ReadonlyMap<string, Kind> = new Map<string, Kind>([
  ['sectionheader', 'heading'],
  ['title', 'heading'],
  ['listitem', 'list'],
  ['listgroup', 'list'],
  ['caption', 'caption'],
  ['footnote', 'caption'],
  ['formula', 'formula'],
  ['equation', 'formula'],
  ['code', 'code'],
  ['codeblock', 'code'],
  ['table', 'table'],
  // `figure`: an image-like container, silent when empty, a paragraph when
  // the transcriber read text inside it.
  ['picture', 'figure'],
  ['figure', 'figure'],
  ['image', 'figure'],
  ['diagram', 'figure'],
  ['picturegroup', 'figure'],
  ['tablegroup', 'figure'],
])
const ENGINE_OF_TRANSCRIBER: ReadonlyMap<string, string> = new Map([
  ['native', 'docling'],
  ['surya', 'surya-ocr'],
])

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/** The kei-exp segment identity FREE's ids are built from. */
export function segmentIdentity(pageNumber: number, index: number): string {
  return `p${pageNumber}_s${index}`
}

export function listedPages(manifest: KeiExpManifest): number[] {
  return Object.keys(manifest.pages)
    .map(Number)
    .sort((left, right) => left - right)
}

/**
 * A page file proven to belong to the manifest: listed, hashing to its entry,
 * naming its page and the manifest's generation (kei-exp's `read_page`).
 */
export function verifiedPage(
  manifest: KeiExpManifest,
  number: number,
  bytes: Uint8Array,
): KeiExpPage {
  const entry = manifest.pages[String(number)]
  if (!entry)
    throw new Error(`kei-exp page ${number} is not listed in the result`)
  if (sha256(bytes) !== entry.sha256)
    throw new Error(`kei-exp page ${number} does not hash to its manifest entry`)
  const page = keiExpPageSchema.parse(
    JSON.parse(new TextDecoder().decode(bytes)),
  )
  if (page.page !== number)
    throw new Error(`kei-exp page file ${number} says page ${page.page}`)
  if (page.generation !== manifest.generation)
    throw new Error(`kei-exp page ${number} belongs to another generation`)
  if (page.complete !== entry.complete)
    throw new Error(
      `kei-exp page ${number} disagrees with the manifest about completeness`,
    )
  return page
}

function kindOf(label: string): Kind {
  return (
    KIND_OF_LABEL.get(label.toLowerCase().replace(/[^a-z]/g, '')) ?? 'paragraph'
  )
}

function clamped(
  [x0, y0, x1, y1]: KeiExpSegment['bbox_pt'],
  width: number,
  height: number,
): { bbox: Bbox | null; moved: number } {
  const within = (value: number, high: number) =>
    Math.min(Math.max(value, 0), high)
  const bbox = {
    x0: within(x0, width),
    y0: within(y0, height),
    x1: within(x1, width),
    y1: within(y1, height),
  }
  const moved = Math.max(
    Math.abs(bbox.x0 - x0),
    Math.abs(bbox.y0 - y0),
    Math.abs(bbox.x1 - x1),
    Math.abs(bbox.y1 - y1),
  )
  return { bbox: bbox.x1 > bbox.x0 && bbox.y1 > bbox.y0 ? bbox : null, moved }
}

function blockOf(
  kind: Kind,
  segment: KeiExpSegment,
  blockId: string,
  pageNumber: number,
  bbox: Bbox | null,
): ParsedContentBlock {
  const common = {
    block_id: blockId,
    page_number: pageNumber,
    parser: PARSER_NAME,
    bbox,
    markdown_span: null,
  }
  const { text } = segment
  const html = segment.html ?? ''
  switch (kind) {
    case 'heading': {
      const level = /^\s*<h([1-6])\b/i.exec(html)
      return {
        ...common,
        kind: 'heading',
        text,
        level: level ? Number(level[1]) : 1,
      }
    }
    case 'list':
      return {
        ...common,
        kind: 'list',
        ordered: /<ol\b/i.test(html),
        items: text
          .split('\n')
          .map((item) => item.trim())
          .filter((item) => item !== ''),
      }
    case 'caption':
      return { ...common, kind: 'caption', text }
    case 'formula':
      return { ...common, kind: 'formula', text }
    case 'code':
      return { ...common, kind: 'code', text, language: null }
    case 'table':
      return segment.table
        ? { ...common, kind: 'table', table_id: blockId.replace(/^b_/, 't_') }
        : { ...common, kind: 'text', text }
    case 'figure':
    case 'paragraph':
      return { ...common, kind: 'paragraph', text }
  }
}

function draftsOf(
  page: KeiExpPage,
  transcriber: string,
  diagnostics: Diagnostic[],
): Draft[] {
  const [width, height] = page.size_pt
  const drafts: Draft[] = []
  for (const [index, segment] of page.segments.entries()) {
    const blockId = `b_${segmentIdentity(page.page, index)}`
    const diagnostic = (code: string, detail: string) =>
      diagnostics.push({ code, detail, page_number: page.page })
    if (segment.status !== 'ok') {
      diagnostic(`segment_${segment.status}`, `${blockId} ${segment.label}`)
      continue
    }
    const kind = segment.table ? 'table' : kindOf(segment.label)
    if (segment.text.trim() === '') {
      if (kind !== 'figure')
        diagnostic('empty_segment_omitted', `${blockId} ${segment.label}`)
      continue
    }
    const { bbox, moved } = clamped(segment.bbox_pt, width, height)
    if (moved > CLAMP_TOLERANCE_PT) diagnostic('bbox_clamped', blockId)
    if (bbox === null) diagnostic('bbox_empty', blockId)
    if (kind === 'table' && !segment.table)
      diagnostic('table_cell_evidence_unsupported', blockId)
    if (segment.table) validateCells(segment, width, height)
    const input =
      segment.crop === null ? `page-${page.page}` : `crop-${segment.crop}`
    drafts.push({
      block: blockOf(kind, segment, blockId, page.page, bbox),
      producerRef: `${PARSER_NAME}:${transcriber}:${input}`,
      ...(segment.table
        ? { table: segment.table, tableText: segment.text }
        : {}),
    })
  }
  return drafts
}

function validateCells(segment: KeiExpSegment, width: number, height: number) {
  if (!segment.table) return
  const occupied = new Set<string>()
  const text = Array.from(segment.text) // canonical offsets count Unicode code points
  for (const cell of segment.table.cells) {
    if (
      cell.cell_id !== `r${cell.row}_c${cell.column}` ||
      cell.end < cell.start ||
      cell.end > text.length ||
      text.slice(cell.start, cell.end).join('') !== cell.text ||
      cell.row + cell.rowspan > segment.table.rows ||
      cell.column + cell.colspan > segment.table.columns
    )
      throw new Error('Invalid canonical table cell identity, range or grid')
    for (let row = cell.row; row < cell.row + cell.rowspan; row++) {
      for (
        let column = cell.column;
        column < cell.column + cell.colspan;
        column++
      ) {
        const key = `${row}:${column}`
        if (occupied.has(key))
          throw new Error('Overlapping canonical table cells')
        occupied.add(key)
      }
    }
    if (cell.bbox_pt) {
      const [x0, y0, x1, y1] = cell.bbox_pt
      if (
        !cell.bbox_pt.every(Number.isFinite) ||
        !(
          0 <= x0 &&
          x0 < x1 &&
          x1 <= width &&
          0 <= y0 &&
          y0 < y1 &&
          y1 <= height
        )
      )
        throw new Error('Canonical table cell is outside its physical page')
    }
  }
}

/** The Markdown of one block, exactly as `renderMarkdown` writes it. */
export function blockMarkdown(block: ParsedContentBlock): string {
  if (block.kind === 'heading')
    return `${'#'.repeat(block.level)} ${block.text}`
  if (block.kind === 'list')
    return block.items
      .map((item, index) =>
        block.ordered ? `${index + 1}. ${item}` : `- ${item}`,
      )
      .join('\n')
  if (block.kind === 'code')
    return `\`\`\`${block.language ?? ''}\n${block.text}\n\`\`\``
  if ('text' in block) return block.text
  return ''
}

/**
 * Blocks in reading order separated by blank lines, pages contiguous, LF line
 * endings; every span is the UTF-8 byte range of what was just written.
 */
function renderMarkdown(pages: DraftPage[]): {
  markdown: Uint8Array
  pages: RenderedPage[]
} {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  let length = 0
  const write = (text: string) => {
    const bytes = encoder.encode(text)
    chunks.push(bytes)
    length += bytes.byteLength
  }
  const rendered: RenderedPage[] = []
  for (const { page, drafts } of pages) {
    if (drafts.length === 0) {
      rendered.push({ page, span: null, blocks: [] })
      continue
    }
    if (length > 0) write('\n\n')
    const start = length
    const blocks: RenderedPage['blocks'] = []
    for (const [index, draft] of drafts.entries()) {
      if (index > 0) write('\n\n')
      const blockStart = length
      write(draft.tableText ?? blockMarkdown(draft.block))
      blocks.push({
        ...draft,
        block: {
          ...draft.block,
          markdown_span: { start: blockStart, end: length },
        },
        producerRef: draft.producerRef,
      })
    }
    rendered.push({ page, span: { start, end: length }, blocks })
  }
  if (length > 0) write('\n')
  const markdown = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    markdown.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { markdown, pages: rendered }
}

function finishedAt(manifest: KeiExpManifest): string | null {
  if (manifest.started === null || manifest.seconds === null) return null
  const started = Date.parse(manifest.started)
  return Number.isFinite(started)
    ? new Date(started + manifest.seconds * 1000).toISOString()
    : null
}

function parserVersion(manifest: KeiExpManifest): string {
  const { transcriber, model, record, versions = {} } = manifest.recipe
  // Native text read by Docling, its textless artwork by the run's OCR model: Surya's engine version when the
  // run recorded one, else the model (a VLM's pipeline is Docling's, already named).
  if (transcriber === 'hybrid' && typeof versions.docling === 'string') {
    const engine = record && !record.spec ? ENGINE_OF_TRANSCRIBER.get('surya') : undefined
    const ocr = engine !== undefined && typeof versions[engine] === 'string' ? `${engine} ${versions[engine]}` : model
    return `docling ${versions.docling} + ${ocr}`
  }
  const engine = ENGINE_OF_TRANSCRIBER.get(transcriber)
  if (engine !== undefined && typeof versions[engine] === 'string')
    return `${engine} ${versions[engine]}`
  return model ? `${transcriber} ${model}` : transcriber
}

function serviceVersion(manifest: KeiExpManifest): string | null {
  const entries = Object.entries(manifest.recipe.versions ?? {})
  if (entries.length === 0) return null
  return entries.map(([name, version]) => `${name} ${version}`).join(', ')
}

/**
 * One run's accepted result as a validated `parsed_document.v2` and the
 * Markdown its spans index. Refuses an incomplete run, a result of another
 * Source Document, and a result that does not cover every physical page.
 */
export function parsedDocumentFromKeiExp(
  runId: string,
  manifest: KeiExpManifest,
  pages: readonly KeiExpPage[],
  source: KeiExpSource,
  now: Date,
): TranslatedDocument {
  if (manifest.status !== 'success')
    throw new Error(
      `kei-exp run ${runId} is incomplete, and nothing truncated is imported: ${manifest.incomplete ?? 'no reason recorded'}`,
    )
  if (manifest.recipe.source_sha256 !== source.sha256)
    throw new Error(`kei-exp run ${runId} parsed another Source Document`)
  const byNumber = new Map(pages.map((page) => [page.page, page]))
  const covered =
    byNumber.size === pages.length &&
    byNumber.size === manifest.page_count &&
    [...byNumber.keys()].every(
      (number) => number >= 1 && number <= manifest.page_count,
    )
  if (!covered)
    throw new Error(
      `kei-exp run ${runId} returned ${byNumber.size} page files for ${manifest.page_count} physical pages`,
    )
  if (pages.some((page) => page.generation !== manifest.generation))
    throw new Error(
      `kei-exp run ${runId} mixed page files of another generation`,
    )

  const diagnostics: Diagnostic[] = []
  const warnings: string[] = []
  const ordered = [...byNumber.values()].sort(
    (left, right) => left.page - right.page,
  )
  const drafted: DraftPage[] = ordered.map((page) => {
    for (const warning of page.warnings) {
      warnings.push(`page ${page.page}: ${warning}`)
      diagnostics.push({
        code: 'page_warning',
        detail: warning,
        page_number: page.page,
      })
    }
    return {
      page,
      drafts: draftsOf(page, manifest.recipe.transcriber, diagnostics),
    }
  })
  const rendered = renderMarkdown(drafted)

  const preprocessId = `${PARSER_NAME}:${runId}:${manifest.generation}`
  const contentStream: ParsedContentBlock[] = []
  const anchors: ParsedEvidenceAnchor[] = []
  const tables: ParsedLogicalTable[] = []
  const documentPages: ParsedDocumentPage[] = []
  for (const { page, span, blocks } of rendered.pages) {
    for (const { block, producerRef, table } of blocks) {
      contentStream.push(block)
      const identity = block.block_id.slice('b_'.length)
      if (block.bbox !== null && block.markdown_span !== null)
      anchors.push({
        kind: 'text',
        anchor_id: `a_${identity}`,
        content_sha256: source.sha256,
        preprocess_id: preprocessId,
        block_id: block.block_id,
        markdown_span: block.markdown_span,
        producer_observations: [
          {
            occurrence_id: `o_${identity}`,
            page_number: page.page,
            producer_ref: producerRef,
            bbox: block.bbox,
          },
        ],
      })
      if (block.kind === 'table' && table) {
        const cells: ParsedLogicalTable['cells'] = []
        for (const cell of table.cells) {
          if (!cell.bbox_pt) {
            diagnostics.push({
              code: 'table_cell_geometry_unavailable',
              detail: `${identity}:${cell.cell_id}`,
              page_number: page.page,
            })
            continue
          }
          const [x0, y0, x1, y1] = cell.bbox_pt
          const bbox = { x0, y0, x1, y1 }
          const anchorId = `a_${identity}_${cell.cell_id}`
          cells.push({
            cell_id: cell.cell_id,
            row: cell.row,
            column: cell.column,
            text: cell.text,
            role: cell.role,
            rowspan: cell.rowspan,
            colspan: cell.colspan,
            bbox,
            evidence_anchor_id: anchorId,
          })
          anchors.push({
            kind: 'table_cell',
            anchor_id: anchorId,
            content_sha256: source.sha256,
            preprocess_id: preprocessId,
            logical_table_id: block.table_id,
            cell_id: cell.cell_id,
            canonical_row: cell.row,
            canonical_column: cell.column,
            producer_observations: [
              {
                occurrence_id: `o_${identity}_${cell.cell_id}`,
                page_number: page.page,
                producer_ref: producerRef,
                row_offset: cell.row,
                column_offset: cell.column,
                row_span: cell.rowspan,
                column_span: cell.colspan,
                bbox,
              },
            ],
          })
        }
        const attribution = {
          parser: table.producer,
          version: manifest.recipe.versions?.[table.producer] ?? null,
        }
        tables.push({
          table_id: block.table_id,
          rows: table.rows,
          cols: table.columns,
          cells,
          spans: [
            {
              page_number: page.page,
              producer_table_ref: producerRef,
              page_local_row_start: 0,
              page_local_row_end: table.rows ? table.rows - 1 : null,
              page_local_col_count: table.columns,
            },
          ],
          parser_attribution: {
            content_parser: attribution,
            structure_parser: attribution,
            geometry_parser: attribution,
          },
          continuation: 'page_local',
        })
      }
    }
    documentPages.push({
      page_number: page.page,
      width_pt: page.size_pt[0],
      height_pt: page.size_pt[1],
      rotation: 0,
      ordered_content: blocks.map(({ block }) => block.block_id),
      unplaced_content: [],
      markdown_span: span,
    })
  }

  const document: ParsedDocument = {
    schema_version: 'parsed_document.v2',
    document: {
      document_id: runId,
      content_sha256: source.sha256,
      source: {
        kind: 'upload',
        original_filename: source.originalFilename,
        media_type: 'application/pdf',
        byte_size: source.byteSize,
      },
      created_at: now.toISOString(),
      page_count: manifest.page_count,
      language_hints: [],
      is_encrypted: null,
      input_profile: {
        file_kind: 'pdf',
        detected_mime: 'application/pdf',
        pdf_version: null,
        has_text_layer: manifest.recipe.transcriber === 'native' || manifest.recipe.transcriber === 'hybrid',
        has_images: null,
      },
    },
    preprocessing: {
      preprocess_id: preprocessId,
      profile: PARSER_NAME,
      service_version: serviceVersion(manifest),
      started_at: manifest.started,
      finished_at: finishedAt(manifest),
      status: diagnostics.length > 0 ? 'completed_with_warnings' : 'completed',
      warnings,
    },
    page_count: manifest.page_count,
    page_mapping_verified: true,
    artifacts: {
      source_ref: 'source.pdf',
      parsed_json_ref: 'parsed_document.json',
      markdown_ref: 'artifacts/document.llm.md',
    },
    parser_runs: [
      {
        parser: PARSER_NAME,
        version: parserVersion(manifest),
        status: 'success',
        warnings,
        error: null,
      },
    ],
    arbitration: { primary_document_parser: PARSER_NAME },
    diagnostics,
    content_stream: contentStream,
    pages: documentPages,
    tables,
    evidence_index: { anchors },
  }
  return {
    document: decodeParsedDocument(document),
    markdown: rendered.markdown,
  }
}
