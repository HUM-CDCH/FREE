import { describe, expect, it } from 'vitest'
import type { ParsedDocument } from '../shared/parsedDocument.js'
import {
  MAX_CATALOG_RECORDS,
  catalogSliceSource,
  headingCandidateSource,
  headingCandidates,
  parseDiscoveryStarts,
  resolveCatalogBoundaries,
} from './_catalog.js'

function documentWithHeadings(
  headings: readonly { text: string; level: number; body?: string }[],
): ParsedDocument {
  const content_stream: ParsedDocument['content_stream'] = []
  const ordered_content: string[] = []
  const anchors: ParsedDocument['evidence_index']['anchors'] = []
  headings.forEach((heading, index) => {
    for (const [suffix, kind, text] of [
      ['heading', 'heading', heading.text],
      ['body', 'paragraph', heading.body ?? `Body ${index + 1}`],
    ] as const) {
      const block_id = `${suffix}-${index}`
      const anchor_id = `anchor-${suffix}-${index}`
      ordered_content.push(block_id)
      const common = {
        block_id,
        page_number: 1,
        parser: 'fixture',
        bbox: null,
        markdown_span: null,
      }
      content_stream.push(
        kind === 'heading'
          ? { ...common, kind, text, level: heading.level }
          : { ...common, kind, text },
      )
      anchors.push({
        kind: 'text',
        anchor_id,
        occurrence_id: `occurrence-${suffix}-${index}`,
        content_sha256: 'a'.repeat(64),
        preprocess_id: 'fixture',
        block_id,
        page_number: 1,
        markdown_span: { start: index * 10, end: index * 10 + 1 },
        bbox: { x0: 0, y0: 0, x1: 1, y1: 1 },
      })
    }
  })
  return {
    schema_version: 'parsed_document.v2',
    document: {} as ParsedDocument['document'],
    preprocessing: {} as ParsedDocument['preprocessing'],
    page_count: 1,
    page_mapping_verified: true,
    artifacts: {} as ParsedDocument['artifacts'],
    parser_runs: [],
    arbitration: null,
    diagnostics: [],
    content_stream,
    pages: [
      {
        page_number: 1,
        width_pt: 100,
        height_pt: 100,
        rotation: 0,
        ordered_content,
        unplaced_content: [],
        markdown_span: null,
      },
    ],
    tables: [],
    evidence_index: { anchors },
  }
}

const zhang = documentWithHeadings([
  { text: '1. Introduction', level: 1, body: 'Introduction body' },
  { text: '1.1. Context', level: 2 },
  { text: '2. Materials and Methods', level: 1, body: 'Methods body' },
  { text: '2.1. Sample Collection', level: 2 },
  { text: '3. Results and Discussion', level: 1, body: 'Results body' },
  { text: 'References', level: 1, body: 'Reference body' },
])

describe('Catalog canonical heading discovery', () => {
  it('publishes compact opaque labels with trustworthy heading levels', () => {
    const candidates = headingCandidates(zhang)

    expect(candidates.map(({ label, text, level }) => ({ label, text, level }))).toEqual([
      { label: 'H-A', text: '1. Introduction', level: 1 },
      { label: 'H-B', text: '1.1. Context', level: 2 },
      { label: 'H-C', text: '2. Materials and Methods', level: 1 },
      { label: 'H-D', text: '2.1. Sample Collection', level: 2 },
      { label: 'H-E', text: '3. Results and Discussion', level: 1 },
      { label: 'H-F', text: 'References', level: 1 },
    ])
    expect(headingCandidateSource(candidates)).not.toContain('anchor-')
  })

  it('offers every canonical heading to discovery', () => {
    expect(
      headingCandidates(zhang).map((candidate) => candidate.label),
    ).toEqual(['H-A', 'H-B', 'H-C', 'H-D', 'H-E', 'H-F'])
  })

  it('accepts only a compact scalar starts array', () => {
    expect(parseDiscoveryStarts({ starts: ['H-A', 'H-C'] })).toEqual([
      'H-A',
      'H-C',
    ])
    expect(parseDiscoveryStarts({ starts: [{ label: 'H-A' }] })).toBeNull()
    expect(parseDiscoveryStarts(['H-A'])).toBeNull()
  })

  it('rejects a canonical heading label that was not offered to discovery', () => {
    const resolved = resolveCatalogBoundaries(
      zhang,
      ['H-B'],
      headingCandidates(zhang).filter((candidate) =>
        ['H-A', 'H-C', 'H-E'].includes(candidate.label),
      ),
    )

    expect(resolved.boundaries).toEqual([])
    expect(resolved.issues).toEqual([
      {
        code: 'boundary_invalid',
        label: 'H-B',
        reason: 'unknown_label',
      },
    ])
  })

  it('derives ordered sibling boundaries and the terminal end server-side', () => {
    const resolved = resolveCatalogBoundaries(zhang, ['H-A', 'H-C', 'H-E'])

    expect(resolved.issues).toEqual([])
    expect(
      resolved.boundaries.map(({ startLabel, headingText, endAnchorId }) => ({
        startLabel,
        headingText,
        endAnchorId,
      })),
    ).toEqual([
      {
        startLabel: 'H-A',
        headingText: '1. Introduction',
        endAnchorId: 'anchor-heading-2',
      },
      {
        startLabel: 'H-C',
        headingText: '2. Materials and Methods',
        endAnchorId: 'anchor-heading-4',
      },
      {
        startLabel: 'H-E',
        headingText: '3. Results and Discussion',
        endAnchorId: 'anchor-heading-5',
      },
    ])
    expect(catalogSliceSource(zhang, resolved.boundaries[1])).toContain(
      '2.1. Sample Collection',
    )
    expect(catalogSliceSource(zhang, resolved.boundaries[1])).not.toContain(
      '3. Results and Discussion',
    )
  })

  it('retains ordered mixed-level labels while rejecting invalid labels', () => {
    const resolved = resolveCatalogBoundaries(zhang, [
      'H-C',
      'missing',
      'H-C',
      'H-A',
      'H-D',
      'H-E',
    ])

    expect(resolved.boundaries.map((boundary) => boundary.startLabel)).toEqual([
      'H-C',
      'H-D',
      'H-E',
    ])
    expect(resolved.issues.map((issue) => issue.reason)).toEqual([
      'unknown_label',
      'duplicate_label',
      'non_monotonic',
    ])
  })

  it('attempts at most 100 resolved records and exposes the rest', () => {
    const large = documentWithHeadings(
      Array.from({ length: 102 }, (_, index) => ({
        text: `${index + 1}. Record`,
        level: 1,
      })),
    )
    const labels = headingCandidates(large).map((candidate) => candidate.label)
    const resolved = resolveCatalogBoundaries(large, labels)

    expect(resolved.boundaries).toHaveLength(MAX_CATALOG_RECORDS)
    expect(resolved.notAttempted).toHaveLength(2)
  })
})
