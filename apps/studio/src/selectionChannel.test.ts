import { expect, it, vi } from 'vitest'
import { createSelectionChannel } from './selectionChannel'

it('replaces a pending request with the next one and clears it only for its own seq', () => {
  const channel = createSelectionChannel()
  const first = channel.select('a', true, 'extraction')
  const second = channel.select('b', false, 'extraction')
  expect(second).toBeGreaterThan(first)
  expect(channel.snapshot().request).toEqual({ key: 'b', navigate: false, seq: second, extractionId: 'extraction' })
  const before = channel.snapshot()
  channel.consume(first)
  expect(channel.snapshot()).toBe(before)
  channel.consume(second)
  expect(channel.snapshot().request).toBeNull()
})

it('says what is under the pointer only when it changes, and none for an empty list', () => {
  const channel = createSelectionChannel(), listener = vi.fn()
  channel.subscribe(listener)
  channel.hover(['a', 'b'])
  channel.hover(['a', 'b'])
  expect(listener).toHaveBeenCalledTimes(1)
  expect(channel.snapshot().hover).toEqual(['a', 'b'])
  channel.hover([])
  channel.hover(null)
  expect(listener).toHaveBeenCalledTimes(2)
  expect(channel.snapshot().hover).toBeNull()
})

it('merges what is published, keeps the request, and notifies only a change', () => {
  const channel = createSelectionChannel(), listener = vi.fn()
  const unsubscribe = channel.subscribe(listener)
  channel.select('a', true, 'extraction')
  const marks = { describe: new Map(), selected: null, savedLinks: [], extractionId: 'extraction' }
  channel.publish({ marks })
  channel.publish({ dim: null })
  expect(listener).toHaveBeenCalledTimes(2)
  expect(channel.snapshot()).toMatchObject({ marks, dim: null, request: { key: 'a' } })
  unsubscribe()
  channel.publish({ marks: null })
  expect(listener).toHaveBeenCalledTimes(2)
  expect(channel.snapshot().marks).toBeNull()
})
