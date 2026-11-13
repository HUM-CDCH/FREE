import { describe, expect, it } from 'vitest'
import type { DurablePage } from 'extraction/durable-types'
import type { SchemaNode } from 'extraction/schema'
import { bulkApprovable, decided, decisionBody, finalizable, gridColumns, gridLayout, toCheck, type GridValue } from './batchReviewGrid'

type Correction = { revision: number; decision: { action: string; value?: unknown; included?: boolean; evidence?: unknown[] } }
function gridValue(field: string, record: number, overrides: Partial<Omit<GridValue, 'correction'>> & { correction?: Correction | null } = {}): GridValue {
  return {
    id: `${field}-${record}`, recordId: `record-${record}`, fieldId: field, path: ['records', record, field],
    selectionId: 'selection', schemaRevisionId: 'schema', node: { id: field, name: field, type: 'string' },
    modelValue: `${field} ${record}`, evidence: [], links: [], grounding: 'ungrounded', processing: 'saved', lineage: [],
    correction: null, historicalCorrection: null, correctionCompatibility: 'compatible', ...overrides,
  } as unknown as GridValue
}
function gridPage(values: GridValue[], overrides: Partial<DurablePage> = {}): DurablePage {
  const saved = values.filter((value) => value.processing === 'saved')
  return {
    extractionId: 'extraction', snapshotVersion: 3, feedbackVersion: 7, finalization: null, status: 'COMPLETED',
    reviewCounts: { required: saved.length, toCheck: saved.filter(toCheck).length, approved: 0, edited: 0, rejected: 0 },
    values, total: values.length, next: null, coverage: null, schemaRevisionId: 'schema', schemaRevisions: [], ...overrides,
  } as unknown as DurablePage
}

const nodes = [
  { id: 'title', name: 'title', type: 'string' },
  { id: 'year', name: 'year', type: 'integer' },
] as SchemaNode[]

describe('gridColumns', () => {
  it('orders fields by the pinned template, document fields first, unknown fields last', () => {
    const page = gridPage([
      gridValue('extra', 0), gridValue('year', 0), gridValue('title', 0),
      gridValue('source', 0, { node: { id: 'source', name: 'source', type: 'string', valueSource: 'document' } as SchemaNode }),
    ])
    expect(gridColumns([page, gridPage([gridValue('title', 1)])], nodes)).toEqual([
      { fieldId: 'source', name: 'source', document: true },
      { fieldId: 'title', name: 'title', document: false },
      { fieldId: 'year', name: 'year', document: false },
      { fieldId: 'extra', name: 'extra', document: false },
    ])
  })
})

describe('gridLayout', () => {
  it('groups values into records in reading order and keeps document values apart', () => {
    const source = gridValue('source', 0, { node: { id: 'source', name: 'source', type: 'string', valueSource: 'document' } as SchemaNode })
    const layout = gridLayout(gridPage([gridValue('title', 2), gridValue('title', 0), gridValue('year', 0), source]))
    expect(layout.records.map((record) => [record.index, [...record.values.keys()]])).toEqual([[0, ['title', 'year']], [2, ['title']]])
    expect([...layout.document.keys()]).toEqual(['source'])
  })
})

describe('decisions', () => {
  const approved: Correction = { revision: 2, decision: { action: 'APPROVED', included: true, evidence: [] } }

  it('tells To check, decided and bulk-approvable values apart', () => {
    const open = gridValue('title', 0)
    const disagreeing = gridValue('year', 0, { disagreement: [{ path: [], alternatives: [{ value: 1, segments: ['a'] }, { value: 2, segments: ['b'] }] }] })
    const pending = gridValue('title', 1, { correction: { revision: 1, decision: { action: 'PENDING' } } })
    const done = gridValue('title', 2, { correction: approved })
    const missing = gridValue('title', 3, { processing: 'absent' })
    expect([open, disagreeing, pending, done, missing].map(toCheck)).toEqual([true, true, true, false, false])
    expect([open, disagreeing, pending, done, missing].map(bulkApprovable)).toEqual([true, false, true, false, false])
    expect([open, done, missing].map(decided)).toEqual([false, true, false])
  })

  it('saves the document review’s body, bound to the latest revision', () => {
    expect(decisionBody(gridValue('title', 0), 3, 'APPROVED')).toEqual({
      expectedRevision: 0, snapshotVersion: 3, action: 'APPROVED', value: 'title 0', included: true, evidence: [],
    })
    expect(decisionBody(gridValue('title', 0, { correction: approved }), 3, 'EDITED', 'Fixed')).toMatchObject({
      expectedRevision: 2, action: 'EDITED', value: 'Fixed', included: true,
    })
    expect(decisionBody(gridValue('title', 0, { correction: approved }), 3, 'PENDING')).toEqual({
      expectedRevision: 2, snapshotVersion: 3, action: 'PENDING', value: 'title 0', included: false, evidence: [],
    })
  })

  it('finalizes only a page with nothing left to check and no finalization', () => {
    expect(finalizable(gridPage([gridValue('title', 0)]))).toBe(false)
    expect(finalizable(gridPage([gridValue('title', 0, { correction: approved })]))).toBe(true)
    expect(finalizable(gridPage([gridValue('title', 0, { correction: approved })], { finalization: { id: 'f' } } as never))).toBe(false)
    expect(finalizable(gridPage([]))).toBe(false)
  })
})
