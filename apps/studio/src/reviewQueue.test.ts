import { describe, expect, it } from 'vitest'
import type { RailModel, RailRecord, RailRow, ReviewPriority, RowKind } from './reviewVocabulary'
import { checkReason, forwardItems, hasPriority, nextToCheck, oneByOneQueue, previousInQueue, queuePosition } from './reviewQueue'

const row = (record: number, name: string, kind: RowKind = 'to-check', doubt: string | null = null): RailRow => ({
  key: `${record}.${name}`, resultPath: ['records', record, name], name, value: name, extracted: name, kind, link: null,
  decision: null, chip: null, evidence: null, doubt, changed: false, page: null,
})
const record = (index: number, rows: RailRow[], state: RailRecord['state'] = 'finished'): RailRecord =>
  ({ index, label: `Grav ${index}`, page: 1, state, rows, toCheck: rows.filter((each) => each.kind === 'to-check').length })
const model = (records: RailRecord[]): RailModel => ({ document: [], records, counts: {} as RailModel['counts'] })

const keys = (items: ReturnType<typeof oneByOneQueue>) => items.map((item) => item.key)
const noEvidence = (record: number, name: string, priority?: ReviewPriority): RailRow =>
  ({ ...row(record, name), reason: 'Source not found', priority })
const inexact = (record: number, name: string, priority?: ReviewPriority): RailRow =>
  ({ ...row(record, name), link: { resultPath: [], evidenceAnchorId: name, verbatim: false }, priority })

describe('Check first across the saved snapshot', () => {
  it('starts with no Evidence, then not-exact Evidence, then other reasons, and retains document order within each group', () => {
    const disagreement = { ...row(0, 'disagreement'), reason: 'Different readings', disagreement: [] }
    const extraction = model([
      record(2, [inexact(2, 'later'), noEvidence(2, 'unlinked'), row(2, 'ordinary')]),
      record(0, [row(0, 'ordinary'), inexact(0, 'earlier'), disagreement, noEvidence(0, 'unlinked')]),
      record(1, [noEvidence(1, 'not-saved')], 'reading'),
    ])
    expect(keys(oneByOneQueue(extraction))).toEqual([
      '0.unlinked', '2.unlinked', '0.earlier', '2.later', '0.disagreement', '0.ordinary', '2.ordinary',
    ])
    expect(keys(oneByOneQueue(extraction, false))).toEqual([
      '0.ordinary', '0.earlier', '0.disagreement', '0.unlinked', '2.later', '2.unlinked', '2.ordinary',
    ])
    expect(hasPriority(oneByOneQueue(extraction))).toBe(true)
  })

  it('prioritizes a reason over an ordinary field with the same verdict', () => {
    const judged = (name: string, priority?: ReviewPriority): RailRow => ({ ...row(0, name), priority })
    const extraction = model([record(0, [
      judged('ordinary', 'supported'), judged('unjudged'), judged('unsupported', 'unsupported'),
      inexact(0, 'not-exact-but-supported', 'supported'), judged('unavailable', 'to-verify'),
      noEvidence(0, 'unlinked', 'supported'),
    ])])
    const queue = oneByOneQueue(extraction)
    expect(keys(queue)).toEqual([
      '0.unlinked', '0.not-exact-but-supported', '0.unsupported', '0.unavailable', '0.ordinary', '0.unjudged',
    ])
    expect(queue.map(({ row }) => checkReason(row))).toEqual([
      'Source not found', 'Not an exact match', 'Source may not support this value', 'Support could not be checked', null, null,
    ])
    expect(hasPriority(oneByOneQueue(model([record(0, [judged('supported', 'supported'), judged('unjudged')])])))).toBe(false)
  })

  it('queues each populated original scalar once, keeping its saved owner and record context', () => {
    const table = row(1, 'table')
    const first = row(1, 'table › #1 › text')
    const second = noEvidence(1, 'table › #2 › text')
    const document = noEvidence(-1, 'publication')
    const extraction = {
      ...model([record(0, [row(0, 'ordinary'), document]), record(1, [{...table, parts: [first, second]}])]),
      document: [document],
    }
    const priority = oneByOneQueue(extraction)
    expect(keys(priority)).toEqual([document.key, second.key, '0.ordinary', first.key])
    expect(priority[1]).toMatchObject({ownerKey: table.key, record: {index: 1}})
    expect(keys(oneByOneQueue(extraction, false))).toEqual([document.key, '0.ordinary', first.key, second.key])
    expect(queuePosition(priority, second.key)).toMatchObject({at: 2, of: 4, items: [priority[1], priority[3]]})
    expect(keys(forwardItems(priority, document.key, new Set([table.key])))).toEqual(['0.ordinary'])
  })

  it('follows the whole queue in either order and passes decided or blocked values on advance', () => {
    const extraction = model([
      record(0, [row(0, 'a'), row(0, 'b', 'approved'), row(0, 'c')]),
      record(1, [noEvidence(1, 'd'), noEvidence(1, 'e')]),
    ])
    const priority = oneByOneQueue(extraction)
    const document = oneByOneQueue(extraction, false)
    expect(nextToCheck(priority, null)).toBe('1.d')
    expect(nextToCheck(priority, '1.d', new Set(['1.e']))).toBe('0.a')
    expect(nextToCheck(priority, '0.a')).toBe('0.c')
    expect(nextToCheck(priority, '0.c')).toBe('1.d')
    expect(previousInQueue(priority, '0.c')).toBe('0.b')
    expect(nextToCheck(document, '0.c')).toBe('1.d')
    expect(previousInQueue(document, '1.d')).toBe('0.c')
    expect(nextToCheck(oneByOneQueue(model([record(0, [row(0, 'a')])])), '0.a')).toBeNull()
  })
})
