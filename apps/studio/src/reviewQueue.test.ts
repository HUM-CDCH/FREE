import { describe, expect, it } from 'vitest'
import type { RailModel, RailRecord, RailRow, RowKind } from './reviewVocabulary'
import { nextToCheck, previousInRecord, queuePosition, reviewQueue } from './reviewQueue'

const row = (record: number, name: string, kind: RowKind = 'to-check', doubt: string | null = null): RailRow => ({
  key: `${record}.${name}`, resultPath: ['records', record, name], name, value: name, extracted: name, kind, link: null,
  decision: null, chip: null, evidence: null, doubt, changed: false, page: null,
})
const record = (index: number, rows: RailRow[], state: RailRecord['state'] = 'finished'): RailRecord =>
  ({ index, label: `Grav ${index}`, page: 1, state, rows, toCheck: rows.filter((each) => each.kind === 'to-check').length })
const model = (records: RailRecord[]): RailModel => ({ document: [], records, counts: {} as RailModel['counts'] })

describe('the one-by-one queue (results review redesign §4.2)', () => {
  const two = model([
    record(3, [row(3, 'a'), row(3, 'b', 'approved'), row(3, 'c', 'to-check', 'doubt'), row(3, 'site', 'not-reviewable')]),
    record(1, [row(1, 'x'), row(1, 'y')]),
    record(5, [row(5, 'z')], 'reading'),
  ])
  const queue = reviewQueue(two)

  it('orders by record in list order, doubtful links first, then schema order; only decidable values of read records', () => {
    expect(queue.map((item) => item.key)).toEqual(['3.c', '3.a', '3.b', '1.x', '1.y'])
  })

  it('next wraps within the record, then moves to the next record with a value to check; skip postpones', () => {
    expect(nextToCheck(queue, '3.c')).toBe('3.a')
    expect(nextToCheck(queue, '3.a')).toBe('3.c')
    const decided = reviewQueue(model([record(3, [row(3, 'a'), row(3, 'b', 'approved'), row(3, 'c', 'rejected', 'doubt')]), record(1, [row(1, 'x')])]))
    expect(nextToCheck(decided, '3.a')).toBe('1.x')
    expect(nextToCheck(reviewQueue(model([record(3, [row(3, 'a')])])), '3.a')).toBeNull()
  })

  it('previous steps back within the record, decided or not', () => {
    expect(previousInRecord(queue, '3.a')).toBe('3.c')
    expect(previousInRecord(queue, '3.c')).toBe('3.b')
  })

  it('a record read during the run appends its values; position is per record and global', () => {
    const read = reviewQueue(model([...two.records.slice(0, 2), record(5, [row(5, 'z')])]))
    expect(read.at(-1)?.key).toBe('5.z')
    expect(queuePosition(read, '1.y')).toMatchObject({ record: 2, records: 3, at: 2, of: 2 })
  })
})
