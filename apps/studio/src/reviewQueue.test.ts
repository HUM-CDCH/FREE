import { describe, expect, it } from 'vitest'
import type { RailModel, RailRecord, RailRow, ReviewPriority, RowKind } from './reviewVocabulary'
import { checkFirst, checkReason, forwardItems, hasPriority, nextToCheck, oneByOneQueue, previousInQueue, queuePosition, reviewTallies, rowReason, sampleRest, settle, settledReasons } from './reviewQueue'

const row = (record: number, name: string, kind: RowKind = 'to-check', doubt: string | null = null): RailRow => ({
  key: `${record}.${name}`, resultPath: ['records', record, name], name, value: name, extracted: name, kind, link: null,
  chip: null, evidence: null, doubt, changed: false, page: null,
})
const record = (index: number, rows: RailRow[], state: RailRecord['state'] = 'finished'): RailRecord =>
  ({ index, label: `Grav ${index}`, page: 1, state, rows, toCheck: rows.filter((each) => each.kind === 'to-check').length })
const model = (records: RailRecord[]): RailModel => ({ document: [], records, counts: {} as RailModel['counts'] })

const keys = (items: ReturnType<typeof oneByOneQueue>) => items.map((item) => item.key)
const noEvidence = (record: number, name: string, priority?: ReviewPriority): RailRow =>
  ({ ...row(record, name), reason: 'Source not found', priority })
const inexact = (record: number, name: string, priority?: ReviewPriority): RailRow =>
  ({ ...row(record, name, 'to-check', 'Not an exact match'), link: { resultPath: [], evidenceAnchorId: name, verbatim: false }, priority })

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

  it('puts what FREE found, then an unsupported and an uncertain verdict first; a failed, unrun or absent check keeps its document place', () => {
    const judged = (name: string, priority?: ReviewPriority): RailRow => ({ ...row(0, name), priority })
    const extraction = model([record(0, [
      judged('ordinary', 'supported'), judged('unjudged'), judged('failed', 'failed'), judged('uncertain', 'uncertain'),
      judged('unsupported', 'unsupported'), { ...judged('disagreement', 'supported'), reason: 'Different readings in the source', disagreement: [] },
      inexact(0, 'not-exact-but-supported', 'supported'), judged('too-long', 'to-verify'), noEvidence(0, 'unlinked', 'supported'),
    ])])
    const queue = oneByOneQueue(extraction)
    expect(keys(queue)).toEqual([
      '0.unlinked', '0.not-exact-but-supported', '0.disagreement', '0.unsupported', '0.uncertain',
      '0.ordinary', '0.unjudged', '0.failed', '0.too-long',
    ])
    expect(queue.map(({ row }) => checkReason(row))).toEqual([
      'Source not found', 'Not an exact match', 'Different readings in the source', 'The source may not support it',
      'Automatic checks disagree', null, null, null, null,
    ])
    // No verdict to act on, whatever the cause: both orders are the document's and nothing is offered first.
    const unavailable = model([record(0, [judged('a', 'failed'), judged('b'), judged('c', 'to-verify'), judged('d', 'supported')])])
    expect(keys(oneByOneQueue(unavailable))).toEqual(keys(oneByOneQueue(unavailable, false)))
    expect(hasPriority(oneByOneQueue(unavailable))).toBe(false)
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

  it('lets one of the rest follow every third value checked first, the same ones whatever is decided since', () => {
    const rows = [...'abcdefg'].map((name, at) => at < 4 ? inexact(0, name) : row(0, name))
    const extraction = model([record(0, rows), record(1, [row(1, 'h'), row(1, 'i'), row(1, 'j')])])
    const sampled = sampleRest(oneByOneQueue(extraction, false))
    // Four come first, so one of the six others comes early: a whole value from the middle of the document.
    expect(sampled).toEqual(['1.h'])
    expect(keys(oneByOneQueue(extraction, true, sampled))).toEqual(['0.a', '0.b', '0.c', '1.h', '0.d', '0.e', '0.f', '0.g', '1.i', '1.j'])
    expect(keys(oneByOneQueue(extraction, false, sampled))).toEqual(keys(oneByOneQueue(extraction, false)))
    // The queue says which one came early, also when it follows the last value checked first.
    expect(keys(oneByOneQueue(extraction, true, sampled).filter((item) => item.early))).toEqual(['1.h'])
    const three = model([record(0, rows.filter((each) => each.name !== 'd'))])
    expect(oneByOneQueue(three, true, sampleRest(oneByOneQueue(three, false))).map((item) => [item.key, item.early])).toEqual([
      ['0.a', undefined], ['0.b', undefined], ['0.c', undefined], ['0.f', true], ['0.e', undefined], ['0.g', undefined],
    ])
    // Deciding values moves nothing: neither the one decided, nor the one that came early.
    const decided = model([record(0, rows.map((each, at) => at === 1 ? { ...each, kind: 'approved' as const } : each)),
      record(1, [{ ...row(1, 'h'), kind: 'edited' as const }, row(1, 'i'), row(1, 'j')])])
    expect(keys(oneByOneQueue(decided, true, sampled))).toEqual(keys(oneByOneQueue(extraction, true, sampled)))
    // Fewer than three come first: none of the rest is taken out of its place.
    expect(sampleRest(oneByOneQueue(model([record(0, [inexact(0, 'a'), inexact(0, 'b'), row(0, 'c')])]), false))).toEqual([])
  })

  it('counts whole values a decision was made on, and takes a soft reason out of the way only when every one was approved as it was', () => {
    const approved = (each: RailRow): RailRow => ({ ...each, kind: 'approved' })
    const kept = new Set<string>()
    const tallies = (rows: RailRow[]) => reviewTallies(oneByOneQueue(model([record(0, rows)]), false))
    const three = [approved(inexact(0, 'a')), approved(inexact(0, 'b')), approved(inexact(0, 'c')), inexact(0, 'd'), row(0, 'e')]
    expect(tallies(three).get('Not an exact match')).toEqual({ fine: 3, wrong: 0, left: 1 })
    expect([...settledReasons(tallies(three), kept)]).toEqual(['Not an exact match'])
    // Two are not enough; one edited or rejected with that reason, or among the rest, and nothing is taken out.
    expect(settledReasons(tallies(three.slice(1)), kept).size).toBe(0)
    expect(settledReasons(tallies([...three, { ...inexact(0, 'f'), kind: 'rejected' }]), kept).size).toBe(0)
    expect(settledReasons(tallies([...three, { ...row(0, 'g'), kind: 'edited' }]), kept).size).toBe(0)
    // The researcher's own word keeps a reason first; a value with no source is never taken out of the way.
    expect(settledReasons(tallies(three), new Set(['Not an exact match'])).size).toBe(0)
    expect(settledReasons(tallies([approved(noEvidence(0, 'a')), approved(noEvidence(0, 'b')), approved(noEvidence(0, 'c')), noEvidence(0, 'd')]), kept).size).toBe(0)
    // A table is one value, and no decision to learn from while any cell of it is still to check, flagged or not.
    const table = (...parts: RailRow[]): RailRow => ({ ...row(0, 'table'), parts })
    const cells = [approved(inexact(0, 'table#1')), approved(inexact(0, 'table#2')), approved(inexact(0, 'table#3'))]
    expect(tallies([table(...cells, inexact(0, 'table#4'))]).get('Not an exact match')).toEqual({ fine: 0, wrong: 0, left: 1 })
    expect(tallies([table(...cells, row(0, 'table#4'))]).get('Not an exact match')).toEqual({ fine: 0, wrong: 0, left: 0 })
    expect(tallies([table(...cells)]).get('Not an exact match')).toEqual({ fine: 1, wrong: 0, left: 0 })
    // Only a value seen still to check in this review is approved in it; one edited or rejected before still counts.
    const before = [...three, { ...inexact(0, 'f'), kind: 'rejected' as const }]
    expect(reviewTallies(oneByOneQueue(model([record(0, before)]), false), new Set(['0.a'])).get('Not an exact match'))
      .toEqual({ fine: 1, wrong: 1, left: 1 })
    // An edited or rejected composite value without parts attributes the decision to every original cell reason.
    const editedTable: RailRow = { ...row(0, 'editedTable', 'edited'), partReasons: ['Not an exact match', 'The source may not support it'] }
    const multiTallies = tallies([...three, editedTable])
    expect(multiTallies.get('Not an exact match')).toEqual({ fine: 3, wrong: 1, left: 1 })
    expect(multiTallies.get('The source may not support it')).toEqual({ fine: 0, wrong: 1, left: 0 })
  })

  it('keeps different readings a fact to act on, whatever their link: no approval of other values settles them', () => {
    const contested = { ...inexact(0, 'contested'), reason: 'Different readings in the source', disagreement: [] }
    expect(checkReason(contested)).toBe('Different readings in the source')
    const settled = settle(model([record(0, [row(0, 'plain'), contested])]), new Set(['Not an exact match']))
    expect(keys(oneByOneQueue(settled))).toEqual(['0.contested', '0.plain'])
  })

  it('keeps a settled value\'s reason on it while it no longer comes first', () => {
    const judged = (name: string, priority: ReviewPriority): RailRow => ({ ...row(0, name), priority })
    const extraction = model([record(0, [row(0, 'plain'), judged('doubted', 'unsupported'), inexact(0, 'inexact'), { ...row(0, 'table'), parts: [judged('cell', 'unsupported')] }])])
    const settled = settle(extraction, new Set(['The source may not support it']))
    expect(keys(oneByOneQueue(extraction))).toEqual(['0.inexact', '0.doubted', '0.cell', '0.plain'])
    expect(keys(oneByOneQueue(settled))).toEqual(['0.inexact', '0.plain', '0.doubted', '0.cell'])
    const doubted = oneByOneQueue(settled).find((item) => item.key === '0.doubted')!.row
    expect([checkFirst(doubted), checkReason(doubted)]).toEqual([false, 'The source may not support it'])
    // What an automatic check says carries how far to trust it wherever the row says it; a fact does not.
    expect(rowReason(doubted)).toBe('The source may not support it · automatic check, often wrong')
    expect(rowReason(oneByOneQueue(settled)[0]!.row)).toBe('Not an exact match')
    expect(settle(extraction, new Set())).toBe(extraction)
  })
})
