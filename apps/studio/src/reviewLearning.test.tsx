// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
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
const hook = (props: { kinds?: Record<string, RowKind>; learning?: boolean; holding?: boolean } = {}) => renderHook(
  ({ kinds = {}, learning = true, holding = false }: typeof props) => useReviewLearning(model(kinds), learning, holding), { initialProps: props })
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
  expect(nextToCheck(result.current.queueAfter(model(three), true), 'c')).toBe('d')
  expect(nextToCheck(result.current.queueAfter(model({ ...two, c: 'rejected' }), true), 'c')).toBe('h')
})
