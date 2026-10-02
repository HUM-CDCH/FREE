import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ParsedDocument } from 'extraction/parsed-document'
import {
  blockMarkdown,
  keiExpManifestSchema,
  listedPages,
  parsedDocumentFromKeiExp,
  verifiedPage,
  type KeiExpManifest,
  type KeiExpPage,
  type KeiExpSegment,
} from './_kei_exp.js'

// `uv run kei-exp main.pdf --result-dir ...` over kei-exp's born-digital sample:
// eight pages through the native Docling path, one whole-page segment each.
const FIXTURE = resolve(import.meta.dirname, '../test/fixtures/kei-exp')
const SAMPLE_SHA256 =
  '641e16c209b792546e79ca2a660e14ecf6750c3c027ffb46a3b89f9a79770293'
const NOW = new Date('2026-09-22T13:00:00.000Z')
const decoder = new TextDecoder()

async function fixture() {
  const manifest = keiExpManifestSchema.parse(
    JSON.parse(await readFile(resolve(FIXTURE, 'result.json'), 'utf8')),
  )
  const pages = await Promise.all(
    listedPages(manifest).map(async (number) =>
      verifiedPage(
        manifest,
        number,
        new Uint8Array(await readFile(resolve(FIXTURE, 'pages', `${number}.json`))),
      ),
    ),
  )
  return { manifest, pages }
}

function translate(manifest: KeiExpManifest, pages: KeiExpPage[]) {
  return parsedDocumentFromKeiExp(
    'run-1',
    manifest,
    pages,
    { sha256: manifest.recipe.source_sha256, originalFilename: 'main.pdf', byteSize: 1234 },
    NOW,
  )
}

function slice(markdown: Uint8Array, span: { start: number; end: number }) {
  return decoder.decode(markdown.subarray(span.start, span.end))
}

function expectSpansSliceBack(document: ParsedDocument, markdown: Uint8Array) {
  const blocks = new Map(document.content_stream.map((block) => [block.block_id, block]))
  expect(document.evidence_index.anchors.length).toBeGreaterThan(0)
  for (const anchor of document.evidence_index.anchors) {
    expect(anchor.kind).toBe('text')
    if (anchor.kind !== 'text') continue
    const block = blocks.get(anchor.block_id)
    expect(block).toBeDefined()
    if (!block) continue
    expect(slice(markdown, anchor.markdown_span)).toBe(blockMarkdown(block))
    if ('text' in block && block.kind !== 'heading' && block.kind !== 'code')
      expect(slice(markdown, anchor.markdown_span)).toBe(block.text)
  }
  let previousEnd = 0
  for (const page of document.pages) {
    if (page.markdown_span === null) {
      expect(page.ordered_content).toEqual([])
      continue
    }
    expect(page.markdown_span.start).toBeGreaterThanOrEqual(previousEnd)
    for (const blockId of page.ordered_content) {
      const span = blocks.get(blockId)?.markdown_span
      expect(span).not.toBeNull()
      if (!span) continue
      expect(span.start).toBeGreaterThanOrEqual(page.markdown_span.start)
      expect(span.end).toBeLessThanOrEqual(page.markdown_span.end)
    }
    previousEnd = page.markdown_span.end
  }
  const text = decoder.decode(markdown)
  expect(text).not.toContain('\r')
  expect(text.endsWith('\n')).toBe(true)
}

function expectBoxesWithinPages(document: ParsedDocument) {
  const pages = new Map(document.pages.map((page) => [page.page_number, page]))
  for (const anchor of document.evidence_index.anchors)
    for (const observation of anchor.producer_observations) {
      const page = pages.get(observation.page_number)
      expect(page).toBeDefined()
      if (!page) continue
      const { x0, y0, x1, y1 } = observation.bbox
      expect(x0).toBeGreaterThanOrEqual(0)
      expect(y0).toBeGreaterThanOrEqual(0)
      expect(x1).toBeGreaterThan(x0)
      expect(y1).toBeGreaterThan(y0)
      expect(x1).toBeLessThanOrEqual(page.width_pt)
      expect(y1).toBeLessThanOrEqual(page.height_pt)
    }
}

function segment(overrides: Partial<KeiExpSegment>): KeiExpSegment {
  return {
    text: 'Body text',
    html: null,
    markdown: null,
    label: 'Text',
    confidence: 0.9,
    status: 'ok',
    unit: 0,
    crop: 7,
    bbox_px: [0, 0, 10, 10],
    bbox_pt: [10, 10, 200, 40],
    extent: 'block',
    ...overrides,
  }
}

function suryaRun(segments: KeiExpSegment[], warnings: string[] = []) {
  const manifest: KeiExpManifest = {
    result_version: 5,
    generation: 'gen-surya',
    recipe: {
      source_sha256: 'b'.repeat(64),
      transcriber: 'surya',
      model: 'surya',
      versions: { docling: '2.127.0', 'surya-ocr': '0.22.1' },
    },
    page_count: 2,
    started: '2026-09-22T12:03:13.269538+00:00',
    seconds: 10,
    status: 'success',
    incomplete: null,
    pages: { '1': { sha256: 'x', complete: true }, '2': { sha256: 'y', complete: true } },
  }
  const pages: KeiExpPage[] = [
    { generation: 'gen-surya', page: 1, size_pt: [612, 792], segments, complete: true, warnings },
    { generation: 'gen-surya', page: 2, size_pt: [612, 792], segments: [], complete: true, warnings: ['no content found by the layout cut'] },
  ]
  return { manifest, pages }
}

describe('kei-exp translation', () => {
  it('keeps native and image OCR evidence on a hybrid page', () => {
    const { manifest, pages } = suryaRun([
      segment({ label: 'Text', text: 'Native prose', crop: null, bbox_pt: [72, 50, 400, 80] }),
      segment({ label: 'Text', text: 'Image table text', crop: 1, bbox_pt: [72, 120, 400, 220] }),
      segment({ label: 'Text', text: 'Native between', crop: null, bbox_pt: [72, 240, 400, 260] }),
      segment({ label: 'Text', text: 'Second image text', crop: 2, bbox_pt: [72, 300, 400, 400] }),
    ])
    manifest.recipe.transcriber = 'hybrid'
    manifest.recipe.record = { spec: null }
    const { document, markdown } = translate(manifest, pages)
    expect(document.document.input_profile.has_text_layer).toBe(true)
    expect(document.content_stream.map((block) => block.kind === 'paragraph' && block.text)).toEqual([
      'Native prose', 'Image table text', 'Native between', 'Second image text',
    ])
    const observations = document.evidence_index.anchors.flatMap((anchor) => anchor.producer_observations)
    expect(observations.map((item) => item.producer_ref)).toEqual([
      'kei-exp:hybrid:page-1', 'kei-exp:hybrid:crop-1', 'kei-exp:hybrid:page-1', 'kei-exp:hybrid:crop-2',
    ])
    expect(document.parser_runs[0]).toMatchObject({ version: 'docling 2.127.0 + surya-ocr 0.22.1' })
    expectSpansSliceBack(document, markdown)
    expectBoxesWithinPages(document)
  })

  it('names the OCR engine of a hybrid run only when the run recorded its version', () => {
    const versionOf = (recipe: Partial<KeiExpManifest['recipe']>) => {
      const { manifest, pages } = suryaRun([segment({ text: 'Image table text', crop: 1 })])
      manifest.recipe = { ...manifest.recipe, transcriber: 'hybrid', ...recipe }
      expect(keiExpManifestSchema.safeParse(manifest).success).toBe(true)
      return translate(manifest, pages).document.parser_runs[0].version
    }
    expect(versionOf({ record: { spec: null } })).toBe('docling 2.127.0 + surya-ocr 0.22.1')
    // A VLM record runs in Docling's own pipeline; the Surya package version the service also records is not its.
    expect(versionOf({ model: 'granite_vision', record: { spec: 'Granite-Vision-3.3-2B' } }))
      .toBe('docling 2.127.0 + granite_vision')
    expect(versionOf({ record: { spec: null }, versions: { docling: '2.127.0' } })).toBe('docling 2.127.0 + surya')
    expect(versionOf({ record: undefined })).toBe('docling 2.127.0 + surya')
  })

  it('turns the born-digital sample into a valid parsed_document.v2 with kei-exp provenance', async () => {
    const { manifest, pages } = await fixture()
    const { document, markdown } = translate(manifest, pages)

    expect(document.page_count).toBe(8)
    expect(document.pages.map((page) => page.page_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(document.content_stream).toHaveLength(8)
    expect(document.evidence_index.anchors).toHaveLength(8)
    expect(document.tables).toEqual([])
    expect(document.diagnostics).toEqual([])
    for (const [index, block] of document.content_stream.entries()) {
      expect(block.kind).toBe('paragraph')
      expect(block.page_number).toBe(index + 1)
      expect(block.parser).toBe('kei-exp')
      expect(block.bbox).toEqual({ x0: 0, y0: 0, x1: 595.2760009765625, y1: 841.8900146484375 })
    }
    expect(document.evidence_index.anchors[2]).toMatchObject({
      anchor_id: 'a_p3_s0',
      block_id: 'b_p3_s0',
      preprocess_id: 'kei-exp:run-1:20260922T120315.748740Z-ae6cc6c9',
      content_sha256: SAMPLE_SHA256,
      producer_observations: [
        { occurrence_id: 'o_p3_s0', page_number: 3, producer_ref: 'kei-exp:native:page-3' },
      ],
    })
    expect(document.document).toMatchObject({
      document_id: 'run-1',
      content_sha256: SAMPLE_SHA256,
      source: { kind: 'upload', original_filename: 'main.pdf', byte_size: 1234 },
      created_at: '2026-09-22T13:00:00.000Z',
      page_count: 8,
      input_profile: { has_text_layer: true },
    })
    expect(document.preprocessing).toMatchObject({
      preprocess_id: 'kei-exp:run-1:20260922T120315.748740Z-ae6cc6c9',
      profile: 'kei-exp',
      service_version: 'docling 2.127.0, surya-ocr 0.22.1',
      started_at: '2026-09-22T12:03:13.269538+00:00',
      finished_at: '2026-09-22T12:03:15.747Z',
      status: 'completed',
      warnings: [],
    })
    expect(document.parser_runs).toEqual([
      { parser: 'kei-exp', version: 'docling 2.127.0', status: 'success', warnings: [], error: null },
    ])
    expect(document.arbitration).toEqual({ primary_document_parser: 'kei-exp' })
    expect(decoder.decode(markdown).startsWith('Analyze abstracts of empirical research\n\nGennaro Baratta')).toBe(true)
    expectSpansSliceBack(document, markdown)
    expectBoxesWithinPages(document)
  })

  it('names blocks and anchors after the kei-exp segment identity p{page}_s{index}', () => {
    const { manifest, pages } = suryaRun([
      segment({ label: 'Picture', text: '' }),
      segment({ label: 'Text', status: 'error' }),
      segment({ label: 'Text', text: 'Third segment' }),
    ])
    const { document } = translate(manifest, pages)
    expect(document.content_stream.map((block) => block.block_id)).toEqual(['b_p1_s2'])
    expect(document.evidence_index.anchors.map((anchor) => [anchor.anchor_id, anchor.producer_observations[0].occurrence_id])).toEqual([
      ['a_p1_s2', 'o_p1_s2'],
    ])
  })

  it('maps Surya labels, keeps geometry coarse where it must, and renders spans while writing', () => {
    const { manifest, pages } = suryaRun(
      [
        segment({ label: 'SectionHeader', text: 'Results', html: '<h2>Results</h2>', crop: 3 }),
        segment({ label: 'Text', text: 'A paragraph.' }),
        segment({ label: 'ListGroup', text: 'first\nsecond\n', html: '<ul><li>first</li><li>second</li></ul>' }),
        segment({ label: 'Table', text: 'h1\th2\nc1\tc2', html: '<table><tr><td>h1</td><td>h2</td></tr></table>' }),
        segment({ label: 'Picture', text: '' }),
        segment({ label: 'Caption', text: 'Figure 1' }),
        segment({ label: 'Code', text: 'x = 1' }),
        segment({ label: 'Equation', text: 'E = mc^2' }),
        segment({ label: 'Text', status: 'error', text: '' }),
        segment({ label: 'Text', status: 'skipped', text: '' }),
        segment({ label: 'Text', text: 'Clamped', bbox_pt: [-5, 700, 100, 900] }),
        segment({ label: 'Text', text: 'Off the page', bbox_pt: [700, 0, 800, 50] }),
        segment({ label: 'Text', text: 'Slightly off', bbox_pt: [-0.2, 0, 100, 50] }),
        segment({ label: 'PageHeader', text: 'Running head' }),
        segment({ label: 'Text', text: '   ' }),
        segment({ label: 'text', text: 'Whole page', crop: null, bbox_pt: [0, 0, 612, 792], extent: 'input', bbox_px: null }),
        // Empty group containers are skipped as silently as an empty figure.
        segment({ label: 'PictureGroup', text: '' }),
        segment({ label: 'TableGroup', text: '   ' }),
      ],
      ['one block came back in error'],
    )
    const { document, markdown } = translate(manifest, pages)

    const kinds = document.content_stream.map((block) => [block.block_id, block.kind])
    expect(kinds).toEqual([
      ['b_p1_s0', 'heading'],
      ['b_p1_s1', 'paragraph'],
      ['b_p1_s2', 'list'],
      ['b_p1_s3', 'text'],
      ['b_p1_s5', 'caption'],
      ['b_p1_s6', 'code'],
      ['b_p1_s7', 'formula'],
      ['b_p1_s10', 'paragraph'],
      ['b_p1_s11', 'paragraph'],
      ['b_p1_s12', 'paragraph'],
      ['b_p1_s13', 'paragraph'],
      ['b_p1_s15', 'paragraph'],
    ])
    const blocks = new Map(document.content_stream.map((block) => [block.block_id, block]))
    expect(blocks.get('b_p1_s0')).toMatchObject({ level: 2, text: 'Results' })
    expect(blocks.get('b_p1_s2')).toMatchObject({ ordered: false, items: ['first', 'second'] })
    expect(blocks.get('b_p1_s10')?.bbox).toEqual({ x0: 0, y0: 700, x1: 100, y1: 792 })
    expect(blocks.get('b_p1_s11')?.bbox).toBeNull()
    expect(blocks.get('b_p1_s12')?.bbox).toEqual({ x0: 0, y0: 0, x1: 100, y1: 50 })
    expect(blocks.get('b_p1_s15')?.bbox).toEqual({ x0: 0, y0: 0, x1: 612, y1: 792 })
    const anchors = document.evidence_index.anchors.filter((anchor) => anchor.kind === 'text')
    expect(anchors).toHaveLength(document.evidence_index.anchors.length)
    expect(anchors.map((anchor) => anchor.block_id)).not.toContain('b_p1_s11')
    expect(anchors.find((anchor) => anchor.block_id === 'b_p1_s0')?.producer_observations[0].producer_ref).toBe('kei-exp:surya:crop-3')
    expect(anchors.find((anchor) => anchor.block_id === 'b_p1_s15')?.producer_observations[0].producer_ref).toBe('kei-exp:surya:page-1')

    expect(document.diagnostics).toEqual([
      { code: 'page_warning', detail: 'one block came back in error', page_number: 1 },
      { code: 'table_cell_evidence_unsupported', detail: 'b_p1_s3', page_number: 1 },
      { code: 'segment_error', detail: 'b_p1_s8 Text', page_number: 1 },
      { code: 'segment_skipped', detail: 'b_p1_s9 Text', page_number: 1 },
      { code: 'bbox_clamped', detail: 'b_p1_s10', page_number: 1 },
      { code: 'bbox_clamped', detail: 'b_p1_s11', page_number: 1 },
      { code: 'bbox_empty', detail: 'b_p1_s11', page_number: 1 },
      { code: 'empty_segment_omitted', detail: 'b_p1_s14 Text', page_number: 1 },
      { code: 'page_warning', detail: 'no content found by the layout cut', page_number: 2 },
    ])
    expect(document.preprocessing.status).toBe('completed_with_warnings')
    expect(document.preprocessing.warnings).toEqual([
      'page 1: one block came back in error',
      'page 2: no content found by the layout cut',
    ])
    expect(document.parser_runs[0]).toMatchObject({ version: 'surya-ocr 0.22.1', warnings: document.preprocessing.warnings })
    expect(document.document.input_profile.has_text_layer).toBe(false)
    expect(document.pages[1]).toMatchObject({ ordered_content: [], markdown_span: null })

    const text = decoder.decode(markdown)
    expect(text.startsWith('## Results\n\nA paragraph.\n\n- first\n- second\n\nh1\th2\nc1\tc2\n\nFigure 1\n\n```\nx = 1\n```\n\nE = mc^2\n\n')).toBe(true)
    expectSpansSliceBack(document, markdown)
    expectBoxesWithinPages(document)
  })

  it('refuses incomplete, foreign, partial, and mixed-generation results', async () => {
    const { manifest, pages } = await fixture()
    expect(() => translate({ ...manifest, status: 'incomplete', incomplete: 'page 3 stopped' }, pages)).toThrow(/incomplete/)
    expect(() =>
      parsedDocumentFromKeiExp('run-1', manifest, pages, { sha256: 'c'.repeat(64), originalFilename: 'x.pdf', byteSize: 1 }, NOW),
    ).toThrow(/another Source Document/)
    expect(() => translate(manifest, pages.slice(0, 7))).toThrow(/7 page files for 8/)
    expect(() => translate(manifest, [...pages.slice(0, 7), { ...pages[7], generation: 'other' }])).toThrow(/another generation/)
  })

  it('proves a page file belongs to the manifest before reading it', async () => {
    const manifest = keiExpManifestSchema.parse(
      JSON.parse(await readFile(resolve(FIXTURE, 'result.json'), 'utf8')),
    )
    const bytes = new Uint8Array(await readFile(resolve(FIXTURE, 'pages', '1.json')))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.pages['1'].sha256)
    expect(verifiedPage(manifest, 1, bytes).page).toBe(1)
    expect(() => verifiedPage(manifest, 2, bytes)).toThrow(/does not hash/)
    expect(() => verifiedPage(manifest, 9, bytes)).toThrow(/not listed/)
    const edited = new TextEncoder().encode(decoder.decode(bytes).replace('"page": 1', '"page": 2'))
    const tampered: KeiExpManifest = {
      ...manifest,
      pages: { ...manifest.pages, '1': { sha256: createHash('sha256').update(edited).digest('hex'), complete: true } },
    }
    expect(() => verifiedPage(tampered, 1, edited)).toThrow(/says page 2/)
  })

  it('refuses a version 4 manifest', async () => {
    const raw = JSON.parse(await readFile(resolve(FIXTURE, 'result.json'), 'utf8'))
    expect(keiExpManifestSchema.safeParse(raw).success).toBe(true)
    expect(keiExpManifestSchema.safeParse({ ...raw, result_version: 4 }).success).toBe(false)
  })
})

it('publishes v5 native cells with distinct anchors and unchanged parent text', () => {
  const text =
    'nummer\tbeskrivelse\t\n24-8\tOverarmsknogle\t\n24-17\tOverarmsknogle'
  const values = [
    ['nummer', 'beskrivelse'],
    ['24-8', 'Overarmsknogle'],
    ['24-17', 'Overarmsknogle'],
  ]
  let offset = 0
  const cells = values.flatMap((row, r) =>
    row.map((value, c) => {
      const start = text.indexOf(value, offset)
      offset = start + value.length
      return {
        cell_id: `r${r}_c${c}`,
        row: r,
        column: c,
        rowspan: 1,
        colspan: 1,
        role: r === 0 ? 'column_header' : 'data',
        text: value,
        start,
        end: offset,
        bbox_pt: [10 + c * 100, 10 + r * 20, 95 + c * 100, 28 + r * 20] as [
          number,
          number,
          number,
          number,
        ],
      }
    }),
  )
  const { manifest, pages } = suryaRun([
    segment({
      label: 'Table',
      text,
      bbox_pt: [10, 10, 210, 80],
      table: { rows: 3, columns: 2, producer: 'docling', cells },
    }),
  ])
  const { document, markdown } = translate(manifest, pages)
  expect(document.tables).toHaveLength(1)
  expect(document.tables[0].cells).toHaveLength(6)
  expect(
    document.evidence_index.anchors.map((anchor) => anchor.anchor_id),
  ).toContain('a_p1_s0_r2_c1')
  expect(
    document.evidence_index.anchors.filter(
      (anchor) => anchor.kind === 'table_cell',
    ),
  ).toHaveLength(6)
  expect(decoder.decode(markdown)).toContain(text)
  expectBoxesWithinPages(document)
  cells[2].bbox_pt = [0, 0, 0, 0]
  expect(() => translate(manifest, pages)).toThrow()
})

it('retains the real Ellekilde page 3 table and all 23 measured cell anchors', async () => {
  const measured = JSON.parse(
    await readFile(resolve(FIXTURE, 'ellekilde-table-v5.json'), 'utf8'),
  )
  const { manifest, pages } = suryaRun([measured.segment])
  pages[0].size_pt = measured.size_pt
  const { document, markdown } = translate(manifest, pages)
  const table = document.tables[0]
  expect([table.rows, table.cols, table.cells.length]).toEqual([9, 3, 23])
  expect(table.cells.find((cell) => cell.cell_id === 'r1_c0')?.text).toBe(
    '24-8',
  )
  const repeated = table.cells.filter((cell) => cell.text === 'Overarmsknogle')
  expect(repeated.map((cell) => cell.cell_id)).toEqual(['r1_c1', 'r7_c1'])
  expect(repeated[0].bbox).not.toEqual(repeated[1].bbox)
  expect(decoder.decode(markdown)).toContain(measured.segment.text)
  expectBoxesWithinPages(document)
})
