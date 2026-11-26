// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { DurablePage } from 'extraction/durable-types'
import { durableRailModel, type RetainedValue } from './durableRailModel'
import { useReviewLearning, type ReviewMove } from './reviewLearning'
import { nextToCheck, oneByOneQueue } from './reviewQueue'
import type { RailModel, RailRow, RowKind } from './reviewVocabulary'

const row = (name: string, kind: RowKind, inexact: boolean): RailRow => ({
  key: name, resultPath: ['records', 0, name], name, value: name, extracted: name, kind, chip: null, evidence: null, changed: false, page: null,
  link: { resultPath: [], evidenceAnchorId: name, verbatim: !inexact }, doubt: inexact ? 'Not an exact match' : null,
})
/** Four values not printed as such (a to d) and six plain ones (e to j), with the kinds given by name. */
const model = (kinds: Record<string, RowKind> = {}): RailModel => ({
  document: [], counts: {} as RailModel['counts'],
  records: [{ index: 0, label: 'Record 1', page: 1, state: 'finished', toCheck: 0, rows: [...'abcdefghij'].map((name, at) => row(name, kinds[name] ?? 'to-check', at < 4)) }],
})
const two = { a: 'approved', b: 'approved' } as const
const three = { ...two, c: 'approved' } as const
const hook = (props: { kinds?: Record<string, RowKind>; learning?: boolean; holding?: boolean; live?: boolean } = {}) => renderHook(
  ({ kinds = {}, learning = true, holding = false, live = false }: typeof props) => useReviewLearning(model(kinds), learning, holding, live), { initialProps: props })
type Learned = { current: ReturnType<typeof useReviewLearning> }
const leading = (learned: Learned) => oneByOneQueue(learned.current.model!, true, learned.current.sampled).map((item) => item.key).join('')
const settledRows = (learned: Learned) => learned.current.model!.records[0]!.rows.filter((each) => each.settled).map((each) => each.key).join('')
/** The notice a one-by-one card on `key` shows. */
const noticeOn = (learned: Learned, key: string) => {
  let said: ReviewMove | null = null
  act(() => { said = learned.current.noticeOn(key) })
  return said
}
const SETTLED = { reason: 'Not an exact match', kind: 'settled', fine: 3, left: 1 }

it('lets the rest of a kind return to its place once three were approved as they were, and says so once', () => {
  const { result, rerender } = hook()
  // One of the six plain values comes early, and stays the one.
  expect(leading(result)).toBe('abchdefgij')
  rerender({ kinds: two })
  expect(result.current.moves).toEqual([])
  rerender({ kinds: three })
  expect(result.current.moves).toEqual([SETTLED])
  expect(leading(result)).toBe('abcdefghij')
  // The first card shown after it says it, while it is the one shown; no other card does, nor that one again.
  expect(noticeOn(result, 'd')).toMatchObject({ kind: 'settled', left: 1 })
  rerender({ kinds: three })
  expect(noticeOn(result, 'd')).toMatchObject({ kind: 'settled' })
  expect(noticeOn(result, 'e')).toBeNull()
  expect(noticeOn(result, 'd')).toBeNull()
})

it('learns nothing from an approval saved before this review', () => {
  const { result, rerender } = hook({ kinds: three })
  expect(result.current.moves).toEqual([])
  expect(leading(result)).toBe('abchdefgij')
  rerender({ kinds: { ...three, d: 'approved' } })
  expect(settledRows(result)).toBe('')
})

it('brings them first again when one of that kind, or one of the rest, is edited or rejected', () => {
  const { result, rerender } = hook()
  rerender({ kinds: three })
  expect(leading(result)).toBe('abcdefghij')
  rerender({ kinds: { ...three, e: 'rejected' } })
  expect(result.current.moves).toEqual([{ reason: 'Not an exact match', kind: 'returned', fine: 3, left: 1 }])
  expect(leading(result)).toMatch(/^abchd/)
})

it('brings them first again unsaid when an approval is undone: nothing was edited or rejected', () => {
  const { result, rerender } = hook()
  rerender({ kinds: three })
  rerender({ kinds: two })
  expect(result.current.moves).toEqual([])
  expect(settledRows(result)).toBe('')
})

it('moves nothing while a row is open in the list, also not when the run settles under it', () => {
  const { result, rerender } = hook()
  rerender({ kinds: two, holding: true })
  rerender({ kinds: three, holding: true })
  expect(result.current.moves).toEqual([])
  expect(leading(result)).toMatch(/^abchd/)
  rerender({ kinds: three, holding: false })
  expect(result.current.moves).toHaveLength(1)
  // The run settles with a row open: none of the rest comes early until it closes.
  const running = hook({ learning: false, holding: true })
  running.rerender({ learning: true, holding: true })
  expect(running.result.current.sampled).toEqual([])
  running.rerender({ learning: true, holding: false })
  expect(running.result.current.sampled).toEqual(['h'])
})

it('applies and says nothing of what it learned while learning is off, and nothing false once it is on again', () => {
  const { result, rerender } = hook()
  rerender({ kinds: three })
  expect(settledRows(result)).toBe('abcd')
  // A saved cut, or a run that saves values again: the sequence as it was built.
  rerender({ kinds: three, learning: false })
  expect([result.current.moves, result.current.sampled, settledRows(result), noticeOn(result, 'd')]).toEqual([[], [], '', null])
  rerender({ kinds: three, learning: true })
  expect(result.current.moves).toEqual([SETTLED])
  expect(result.current.sampled).toEqual(['h'])
  expect(noticeOn(result, 'd')).toMatchObject({ kind: 'settled' })
})

it('keeps a kind first for good once the researcher asks for it back', () => {
  const { result, rerender } = hook()
  rerender({ kinds: three })
  act(() => result.current.keep('Not an exact match'))
  expect(result.current.moves).toEqual([])
  expect(leading(result)).toMatch(/^abchd/)
  rerender({ kinds: { ...three, d: 'approved' } })
  expect(result.current.moves).toEqual([])
})

it('gives the sequence a decision just saved makes, before its read arrives', () => {
  const { result, rerender } = hook()
  rerender({ kinds: two })
  // The third approval settles the kind: the fourth is next in its place, not the one of the rest that came early.
  expect(nextToCheck(oneByOneQueue(result.current.model!, true, result.current.sampled), 'c')).toBe('h')
  expect(result.current.nextAfter(model(three), true, 'c')).toBe('d')
  expect(result.current.nextAfter(model({ ...two, c: 'rejected' }), true, 'c')).toBe('h')

  // When a remaining priority value exists after settling, advance to it instead of following the settled value.
  const withReading = (kinds: Record<string, RowKind>): RailModel => ({
    document: [], counts: {} as RailModel['counts'],
    records: [{ index: 0, label: 'Record 1', page: 1, state: 'finished', toCheck: 0, rows: [
      ...'abcdef'.split('').map((name, at) => row(name, kinds[name] ?? 'to-check', at < 4)),
      { ...row('z', kinds.z ?? 'to-check', false), reason: 'Different readings in the source', disagreement: [] },
    ] }],
  })
  const mixed = renderHook(({ kinds = {} as Record<string, RowKind> }) => useReviewLearning(withReading(kinds), true, false, false),
    { initialProps: { kinds: {} as Record<string, RowKind> } })
  mixed.rerender({ kinds: two })
  expect(mixed.result.current.nextAfter(withReading(three), true, 'c')).toBe('z')
  mixed.rerender({ kinds: three })
  // Editing or rejecting an ordinary value brings the settled category back first at once.
  expect(mixed.result.current.nextAfter(withReading({ ...three, e: 'rejected' }), true, 'e')).toBe('d')
  expect(mixed.result.current.nextAfter(withReading({ ...three, e: 'rejected' }), false, 'e')).toBe('f')
})

it('never counts pre-existing approvals when a historical snapshot with open values is viewed', () => {
  const { result, rerender } = hook({ kinds: three })
  expect(result.current.moves).toEqual([])
  expect(leading(result)).toBe('abchdefgij')
  // Opening an older cut where a, b, c were still to check (learning off) must not record them as opened in this review.
  rerender({ kinds: {}, learning: false })
  expect(result.current.moves).toEqual([])
  rerender({ kinds: three, learning: true })
  expect(result.current.moves).toEqual([])
  expect(settledRows(result)).toBe('')
  expect(leading(result)).toBe('abchdefgij')

  // Settled live state is preserved across a historical cut that had an earlier edit/rejection without a false return notice.
  const live = hook()
  live.rerender({ kinds: three })
  expect(live.result.current.moves).toEqual([SETTLED])
  live.rerender({ kinds: { ...three, e: 'rejected' }, learning: false })
  expect(live.result.current.moves).toEqual([])
  live.rerender({ kinds: three, learning: true })
  expect(live.result.current.moves).toEqual([SETTLED])
})

it('attributes a table edit or rejection to every original cell reason, bringing settled categories first again', () => {
  const scalar = (id: string, record: number, approved = false): RetainedValue => ({
    id, recordId: `r${record}`, fieldId: id, path: ['records', record, id], selectionId: 's', schemaRevisionId: 'rev',
    node: { id, name: id, type: 'string' }, modelValue: id, evidence: [], groundings: undefined, grounding: 'grounded',
    processing: 'saved', lineage: [], historicalCorrection: null,
    links: [{ resultPath: ['records', record, id], evidenceAnchorId: id, verbatim: false }],
    correction: approved ? { revision: 1, decision: { action: 'APPROVED', value: id, evidence: [], included: false } } : null,
  } as unknown as RetainedValue)
  const tableNode = {
    id: 'items', name: 'items', type: 'array' as const,
    children: [{ id: 'name', name: 'name', type: 'string' as const }, { id: 'size', name: 'size', type: 'string' as const }],
  }
  const table = (action: 'EDITED' | 'REJECTED' | null): RetainedValue => ({
    id: 't', recordId: 'r4', fieldId: 'items', path: ['records', 4, 'items'], selectionId: 's', schemaRevisionId: 'rev',
    node: tableNode, modelValue: [{ name: 'Cup', size: 'Large' }], evidence: [], grounding: 'grounded',
    processing: 'saved', lineage: [], historicalCorrection: null,
    links: [
      { resultPath: ['records', 4, 'items', 0, 'name'], evidenceAnchorId: 't-name', verbatim: false },
      { resultPath: ['records', 4, 'items', 0, 'size'], evidenceAnchorId: 't-size', verbatim: true },
    ],
    check: { protocol: 1, model: {}, judgments: [{ path: ['records', 4, 'items', 0, 'size'], status: 'ok', label: 0 }] },
    correction: action ? {
      revision: 1,
      decision: action === 'EDITED'
        ? { action: 'EDITED', value: [{ name: 'Bowl', size: 'Large' }], evidence: [], included: true }
        : { action: 'REJECTED', evidence: [], included: false },
    } : null,
  } as unknown as RetainedValue)
  const build = (approvedCount: number, tableAction: 'EDITED' | 'REJECTED' | null) =>
    durableRailModel({ values: [scalar('a', 0, approvedCount >= 1), scalar('b', 1, approvedCount >= 2), scalar('c', 2, approvedCount >= 3), scalar('d', 3), table(tableAction)] } as DurablePage, null)

  for (const action of ['EDITED', 'REJECTED'] as const) {
    const { result, rerender } = renderHook(({ m }: { m: RailModel }) => useReviewLearning(m, true, false, false), { initialProps: { m: build(0, null) } })
    rerender({ m: build(3, null) })
    expect(result.current.moves).toEqual([{ ...SETTLED, left: 2 }])
    rerender({ m: build(3, action) })
    expect(result.current.moves).toContainEqual({ reason: 'Not an exact match', kind: 'returned', fine: 3, left: 1 })
    expect(result.current.model!.records.flatMap((r) => r.rows).filter((r) => r.settled)).toEqual([])
  }
})

it('holds category settling during an in-flight save and supports an explicit pre-save settled baseline', () => {
  const withReading = (kinds: Record<string, RowKind>): RailModel => ({
    document: [], counts: {} as RailModel['counts'],
    records: [{ index: 0, label: 'Record 1', page: 1, state: 'finished', toCheck: 0, rows: [
      ...'abcdef'.split('').map((name, at) => row(name, kinds[name] ?? 'to-check', at < 4)),
      { ...row('z', kinds.z ?? 'to-check', false), reason: 'Different readings in the source', disagreement: [] },
    ] }],
  })
  const { result, rerender } = renderHook(
    ({ kinds = {} as Record<string, RowKind>, holding = false }: { kinds?: Record<string, RowKind>; holding?: boolean }) =>
      useReviewLearning(withReading(kinds), true, holding, false),
    { initialProps: { kinds: {} as Record<string, RowKind>, holding: false } },
  )
  rerender({ kinds: two, holding: false })
  // Polling delivers the third approval while the save is still in flight (`holding: true`).
  const preSaveSettled = result.current.settled
  expect(preSaveSettled.size).toBe(0)
  rerender({ kinds: three, holding: true })
  expect(result.current.settled.size).toBe(0)
  expect(result.current.moves).toEqual([])
  expect(result.current.nextAfter(withReading(three), true, 'c', undefined, undefined, preSaveSettled)).toBe('z')
  // Once the save completes (`holding: false`), the category settles and the notice surfaces on `z`.
  rerender({ kinds: three, holding: false })
  expect(result.current.moves).toEqual([SETTLED])
  expect(noticeOn(result, 'z')).toMatchObject({ kind: 'settled', fine: 3, left: 1 })

  // Even if settled already updated on the hook, passing the pre-save baseline preserves priority advance both ways.
  const settledBeforeReject = result.current.settled
  rerender({ kinds: { ...three, e: 'rejected' }, holding: false })
  expect(result.current.settled.size).toBe(0)
  expect(result.current.nextAfter(withReading({ ...three, e: 'rejected' }), true, 'e', undefined, undefined, settledBeforeReject)).toBe('d')
})

it('never counts approvals made while learning is off (e.g. a resumed run) when learning turns back on, while preserving valid prior learning', () => {
  // 1. PAUSED with a..d open -> RUNNING -> a..c approved while RUNNING -> COMPLETED: none count.
  const resumed = hook()
  expect(leading(resumed.result)).toBe('abchdefgij')
  resumed.rerender({ kinds: {}, learning: false })
  resumed.rerender({ kinds: three, learning: false })
  resumed.rerender({ kinds: three, learning: true })
  expect(resumed.result.current.moves).toEqual([])
  expect(settledRows(resumed.result)).toBe('')
  expect(leading(resumed.result)).toBe('abchdefgij')

  // 2. Two valid approvals before RUNNING + one during RUNNING -> still 2 earned; approving d after completion settles.
  const fiveInexact = (kinds: Record<string, RowKind> = {}): RailModel => ({
    document: [], counts: {} as RailModel['counts'],
    records: [{ index: 0, label: 'Record 1', page: 1, state: 'finished', toCheck: 0, rows: [...'abcdxefghij'].map((name, at) => row(name, kinds[name] ?? 'to-check', at < 5)) }],
  })
  const partial = renderHook(
    ({ kinds = {} as Record<string, RowKind>, learning = true }: { kinds?: Record<string, RowKind>; learning?: boolean }) =>
      useReviewLearning(fiveInexact(kinds), learning, false, false),
    { initialProps: { kinds: {} as Record<string, RowKind>, learning: true } },
  )
  partial.rerender({ kinds: two, learning: true })
  partial.rerender({ kinds: two, learning: false })
  partial.rerender({ kinds: three, learning: false })
  partial.rerender({ kinds: three, learning: true })
  expect(partial.result.current.moves).toEqual([])
  expect(partial.result.current.model!.records[0]!.rows.filter((each) => each.settled)).toEqual([])
  partial.rerender({ kinds: { ...three, d: 'approved' }, learning: true })
  expect(partial.result.current.moves).toEqual([SETTLED])

  // 3. Undoing an approval made while learning was off and re-approving while learning is on makes only that key eligible.
  resumed.rerender({ kinds: two, learning: true })
  resumed.rerender({ kinds: three, learning: true })
  expect(resumed.result.current.moves).toEqual([])
  resumed.rerender({ kinds: {}, learning: true })
  resumed.rerender({ kinds: three, learning: true })
  expect(resumed.result.current.moves).toEqual([SETTLED])

  // 4. Valid partial learning survives viewing a historical cut where those items were still to check.
  const acrossHistory = hook()
  acrossHistory.rerender({ kinds: two, learning: true })
  acrossHistory.rerender({ kinds: {}, learning: false })
  acrossHistory.rerender({ kinds: two, learning: true })
  acrossHistory.rerender({ kinds: three, learning: true })
  expect(acrossHistory.result.current.moves).toEqual([SETTLED])
})

it('stops counting an approval undone while a run saves values, also when it is approved again', () => {
  const { result, rerender } = hook()
  rerender({ kinds: two })
  // The run resumes: a is undone, then approved again, on the live page.
  rerender({ kinds: two, learning: false, live: true })
  rerender({ kinds: { b: 'approved' }, learning: false, live: true })
  rerender({ kinds: two, learning: false, live: true })
  rerender({ kinds: two })
  rerender({ kinds: three })
  expect(result.current.moves).toEqual([])
  expect(settledRows(result)).toBe('')
})
