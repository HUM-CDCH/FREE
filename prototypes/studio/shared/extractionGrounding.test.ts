import { describe, expect, it, vi } from 'vitest'
import bundled from '../src/assets/parsed_document.v2.json'
import {
  groundExtraction,
  type GroundingModelInvoker,
} from './extractionGrounding.js'
import { decodeParsedDocument, type ParsedDocument } from './parsedDocument.js'

const document = decodeParsedDocument(bundled)
const firstAnchorId = document.evidence_index.anchors[0].anchor_id

function documentWithRetrievalTable(): ParsedDocument {
  const tableId = 'retrieval-table'
  const rows = [
    ['Field', 'Value'],
    ['Grave', '24'],
    ['Nearby', '124'],
  ]
  const cells = rows.flatMap((values, row) =>
    values.map((text, column) => ({
      cell_id: `retrieval-cell-${row}-${column}`,
      row,
      column,
      text,
      role: null,
      rowspan: 1,
      colspan: 1,
      bbox: null,
      evidence_anchor_id: `retrieval-anchor-${row}-${column}`,
    })),
  )
  return {
    ...document,
    pages: document.pages.map((page) =>
      page.page_number === 1
        ? { ...page, unplaced_content: [...page.unplaced_content, tableId] }
        : page,
    ),
    tables: [
      ...document.tables,
      {
        table_id: tableId,
        rows: rows.length,
        cols: 2,
        cells,
        spans: [
          {
            page_number: 1,
            producer_table_ref: tableId,
            page_local_row_start: 0,
            page_local_row_end: rows.length - 1,
            page_local_col_count: 2,
          },
        ],
        parser_attribution: {
          content_parser: { parser: 'fixture', version: null },
          structure_parser: { parser: 'fixture', version: null },
          geometry_parser: { parser: 'fixture', version: null },
        },
        continuation: 'page_local',
      },
    ],
    evidence_index: {
      anchors: [
        ...document.evidence_index.anchors,
        ...cells.map((cell) => ({
          kind: 'table_cell' as const,
          anchor_id: cell.evidence_anchor_id,
          content_sha256: document.document.content_sha256,
          preprocess_id: document.preprocessing.preprocess_id,
          logical_table_id: tableId,
          cell_id: cell.cell_id,
          canonical_row: cell.row,
          canonical_column: cell.column,
          producer_observations: [
            {
              occurrence_id: `retrieval-occurrence-${cell.row}-${cell.column}`,
              page_number: 1,
              producer_ref: tableId,
              row_offset: cell.row,
              column_offset: cell.column,
              row_span: 1,
              column_span: 1,
              bbox: { x0: 1, y0: 1, x1: 10, y1: 10 },
            },
          ],
        })),
      ],
    },
  }
}

describe('groundExtraction', () => {
  it('grounds top-level records in deterministic batches over the same source', async () => {
    const requests: Parameters<GroundingModelInvoker>[0][] = []
    const invokeModel: GroundingModelInvoker = vi.fn(async (input) => {
      requests.push(input)
      const firstBatch = requests.length === 1
      return {
        result: {
          links: firstBatch
            ? { C1: 'E1', C2: 'NONE', C999: 'E1' }
            : { C3: 'E1', C4: 'E999' },
        },
        modelAttribution: { provider: 'fixture', batch: requests.length },
      }
    })
    const result = {
      records: [
        {
          grave_number: '24',
          count: 2,
          blank: ' ',
          absent: null,
        },
        {
          grave_number: '25',
          checked: false,
          note: 'second record',
        },
      ],
    }

    const grounded = await groundExtraction({
      document,
      result,
      invokeModel,
    })

    expect(requests).toHaveLength(2)
    expect(requests[0].template).toEqual({
      links: {
        C1: 'verbatim-string',
        C2: 'verbatim-string',
      },
    })
    expect(requests[1].template).toEqual({
      links: {
        C3: 'verbatim-string',
        C4: 'verbatim-string',
        C5: 'verbatim-string',
      },
    })
    expect(requests[0].instruction).toContain(
      '[C1] grave_number = "24"',
    )
    expect(requests[0].instruction).toContain('## records[0]')
    expect(requests[1].instruction).toContain('## records[1]')
    expect(requests[1].instruction).toContain('[C4] checked = false')
    expect(requests[0].instruction).toContain(
      'the only valid output is {"links":{"C1":"E1","C2":"NONE"}}',
    )
    expect(requests[0].instruction).not.toContain('blank')
    expect(requests[0].instruction).not.toContain('absent')
    expect(requests[0].documentMarkdown).toBe(requests[1].documentMarkdown)
    expect(requests[0].documentMarkdown).toContain('### Canonical Evidence')
    expect(requests[0].documentMarkdown).toContain('[E1]')
    expect(requests[0].documentMarkdown).not.toMatch(/bbox|occurrence_id/)
    expect(grounded.evidenceLinks).toEqual([
      {
        resultPath: ['records', 0, 'grave_number'],
        evidenceAnchorId: firstAnchorId,
      },
      {
        resultPath: ['records', 1, 'grave_number'],
        evidenceAnchorId: firstAnchorId,
      },
    ])
    expect(grounded.ungroundedPaths).toEqual([
      ['records', 0, 'count'],
      ['records', 1, 'checked'],
      ['records', 1, 'note'],
    ])
    expect(grounded.issues).toEqual(
      expect.arrayContaining([
        { code: 'unknown_claim_label', claimLabel: 'C999' },
        {
          code: 'unknown_anchor_label',
          claimLabel: 'C4',
          resultPath: ['records', 1, 'checked'],
          anchorLabel: 'E999',
        },
        {
          code: 'missing_claim',
          claimLabel: 'C5',
          resultPath: ['records', 1, 'note'],
        },
      ]),
    )
    expect(grounded.modelAttribution).toEqual({
      strategy: 'retrieval_batched',
      batches: [
        {
          resultPath: ['records', 0],
          candidateCount: 1,
          fallback: true,
          modelAttribution: { provider: 'fixture', batch: 1 },
        },
        {
          resultPath: ['records', 1],
          candidateCount: 1,
          fallback: true,
          modelAttribution: { provider: 'fixture', batch: 2 },
        },
      ],
    })
  })

  it('uses one batch when the result has no top-level records array', async () => {
    const invokeModel: GroundingModelInvoker = vi.fn(async () => ({
      result: { links: { C1: 'E1', C2: 'NONE' } },
      modelAttribution: { provider: 'fixture', batch: 1 },
    }))

    const grounded = await groundExtraction({
      document,
      result: { title: 'Ellekilde', count: 2 },
      invokeModel,
    })

    expect(invokeModel).toHaveBeenCalledOnce()
    expect(grounded.modelAttribution).toEqual({
      strategy: 'retrieval_batched',
      batches: [
        {
          resultPath: null,
          candidateCount: 1,
          fallback: true,
          modelAttribution: { provider: 'fixture', batch: 1 },
        },
      ],
    })
  })

  it('expands a seeded table cell to its logical row in canonical order', async () => {
    const requests: Parameters<GroundingModelInvoker>[0][] = []
    const grounded = await groundExtraction({
      document: documentWithRetrievalTable(),
      result: { records: [{ grave_number: 24 }] },
      invokeModel: async (request) => {
        requests.push(request)
        return {
          result: { links: { C1: 'E2' } },
          modelAttribution: { provider: 'fixture' },
        }
      },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].documentMarkdown).toContain('[E1] Grave | [E2] 24')
    expect(requests[0].documentMarkdown).not.toContain('Nearby')
    expect(requests[0].documentMarkdown).not.toContain('124')
    expect(grounded.evidenceLinks).toEqual([
      {
        resultPath: ['records', 0, 'grave_number'],
        evidenceAnchorId: 'retrieval-anchor-1-1',
      },
    ])
    expect(grounded.modelAttribution).toEqual({
      strategy: 'retrieval_batched',
      batches: [
        {
          resultPath: ['records', 0],
          candidateCount: 2,
          fallback: false,
          modelAttribution: { provider: 'fixture' },
        },
      ],
    })
  })

  it('falls back to the full canonical inventory when retrieval has no seeds', async () => {
    let request: Parameters<GroundingModelInvoker>[0] | undefined
    const grounded = await groundExtraction({
      document: documentWithRetrievalTable(),
      result: { title: 'not present anywhere' },
      invokeModel: async (input) => {
        request = input
        return {
          result: { links: { C1: 'NONE' } },
          modelAttribution: null,
        }
      },
    })

    expect(request?.documentMarkdown).toContain('[E1] Grav 8')
    expect(request?.documentMarkdown).toContain('[E7] 124')
    expect(grounded.evidenceLinks).toEqual([])
    expect(grounded.modelAttribution).toEqual({
      strategy: 'retrieval_batched',
      batches: [
        {
          resultPath: null,
          candidateCount: 7,
          fallback: true,
          modelAttribution: null,
        },
      ],
    })
  })

  it('does not publish a link outside the retrieved call-scoped dictionary', async () => {
    const grounded = await groundExtraction({
      document: documentWithRetrievalTable(),
      result: { records: [{ grave_number: 24 }] },
      invokeModel: async () => ({
        result: { links: { C1: 'E3' } },
        modelAttribution: null,
      }),
    })

    expect(grounded.evidenceLinks).toEqual([])
    expect(grounded.issues).toEqual([
      {
        code: 'unknown_anchor_label',
        claimLabel: 'C1',
        resultPath: ['records', 0, 'grave_number'],
        anchorLabel: 'E3',
      },
    ])
  })

  it('rejects a known anchor that conflicts with an exact candidate', async () => {
    const grounded = await groundExtraction({
      document: documentWithRetrievalTable(),
      result: { records: [{ grave_number: 24 }] },
      invokeModel: async () => ({
        result: { links: { C1: 'E1' } },
        modelAttribution: null,
      }),
    })

    expect(grounded.evidenceLinks).toEqual([])
    expect(grounded.ungroundedPaths).toEqual([
      ['records', 0, 'grave_number'],
    ])
    expect(grounded.issues).toEqual([
      {
        code: 'conflicting_anchor_selection',
        claimLabel: 'C1',
        resultPath: ['records', 0, 'grave_number'],
        anchorLabel: 'E1',
      },
    ])
  })

  it('continues after a failed grounding batch and leaves its claims ungrounded', async () => {
    const invokeModel: GroundingModelInvoker = vi
      .fn()
      .mockRejectedValueOnce(new Error('grounder unavailable'))
      .mockResolvedValueOnce({
        result: { links: { C2: 'E1' } },
        modelAttribution: { provider: 'fixture', batch: 2 },
      })

    const grounded = await groundExtraction({
      document,
      result: {
        records: [{ title: 'first' }, { title: 'Ellekilde' }],
      },
      invokeModel,
    })

    expect(invokeModel).toHaveBeenCalledTimes(2)
    expect(grounded.evidenceLinks).toEqual([
      {
        resultPath: ['records', 1, 'title'],
        evidenceAnchorId: firstAnchorId,
      },
    ])
    expect(grounded.ungroundedPaths).toEqual([['records', 0, 'title']])
    expect(grounded.issues).toEqual([
      { code: 'grounding_failed', resultPath: ['records', 0] },
    ])
    expect(grounded.modelAttribution?.batches).toEqual([
      expect.objectContaining({
        resultPath: ['records', 0],
        modelAttribution: null,
      }),
      expect.objectContaining({
        resultPath: ['records', 1],
        modelAttribution: { provider: 'fixture', batch: 2 },
      }),
    ])
  })

  it('does not dispatch another batch after the signal is aborted', async () => {
    const controller = new AbortController()
    const invokeModel: GroundingModelInvoker = vi.fn(async () => {
      controller.abort()
      return {
        result: { links: { C1: 'E1' } },
        modelAttribution: { provider: 'fixture' },
      }
    })

    await expect(
      groundExtraction({
        document,
        result: {
          records: [{ title: 'first' }, { title: 'second' }],
        },
        signal: controller.signal,
        invokeModel,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(invokeModel).toHaveBeenCalledOnce()
  })

  it('treats malformed selections as ungrounded without retargeting', async () => {
    const grounded = await groundExtraction({
      document,
      result: { title: 'Ellekilde' },
      invokeModel: async () => ({
        result: { links: { C1: null } },
        modelAttribution: null,
      }),
    })

    expect(grounded.evidenceLinks).toEqual([])
    expect(grounded.ungroundedPaths).toEqual([['title']])
    expect(grounded.issues).toEqual([
      {
        code: 'malformed_selection',
        claimLabel: 'C1',
        resultPath: ['title'],
      },
    ])
  })

  it.each([
    null,
    { links: [] },
    { links: {}, commentary: 'extra' },
  ])('leaves claims ungrounded for a malformed response root %#', async (modelResult) => {
    await expect(
      groundExtraction({
        document,
        result: { title: 'Ellekilde' },
        invokeModel: async () => ({ result: modelResult, modelAttribution: null }),
      }),
    ).resolves.toMatchObject({
      evidenceLinks: [],
      ungroundedPaths: [['title']],
      issues: [{ code: 'grounding_failed', resultPath: null }],
    })
  })

  it('skips the model call when there are no populated claims', async () => {
    const invokeModel = vi.fn<GroundingModelInvoker>()

    await expect(
      groundExtraction({
        document,
        result: { title: '', records: [] },
        invokeModel,
      }),
    ).resolves.toEqual({
      evidenceLinks: [],
      ungroundedPaths: [],
      issues: [],
      modelAttribution: null,
    })
    expect(invokeModel).not.toHaveBeenCalled()
  })
})
