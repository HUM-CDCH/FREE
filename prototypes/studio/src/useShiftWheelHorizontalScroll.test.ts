// @vitest-environment jsdom

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useShiftWheelHorizontalScroll } from './useShiftWheelHorizontalScroll'

function makeScrollable() {
  const scrollable = document.createElement('div')
  scrollable.style.overflowX = 'auto'
  Object.defineProperty(scrollable, 'scrollWidth', { value: 400, configurable: true })
  Object.defineProperty(scrollable, 'clientWidth', { value: 100, configurable: true })
  scrollable.scrollLeft = 0
  const child = document.createElement('span')
  scrollable.appendChild(child)
  document.body.appendChild(scrollable)
  return { scrollable, child }
}

function dispatchWheel(
  target: Element,
  init: Partial<WheelEventInit>,
): { defaultPrevented: boolean } {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return { defaultPrevented: event.defaultPrevented }
}

describe('useShiftWheelHorizontalScroll', () => {
  it('scrolls the nearest horizontally-scrollable ancestor on shift+wheel', () => {
    const { scrollable, child } = makeScrollable()
    renderHook(() => useShiftWheelHorizontalScroll())

    const result = dispatchWheel(child, { shiftKey: true, deltaY: 40, deltaX: 0 })

    expect(result.defaultPrevented).toBe(true)
    expect(scrollable.scrollLeft).toBe(40)
    document.body.removeChild(scrollable)
  })

  it('ignores wheel events without shift', () => {
    const { scrollable, child } = makeScrollable()
    renderHook(() => useShiftWheelHorizontalScroll())

    const result = dispatchWheel(child, { shiftKey: false, deltaY: 40, deltaX: 0 })

    expect(result.defaultPrevented).toBe(false)
    expect(scrollable.scrollLeft).toBe(0)
    document.body.removeChild(scrollable)
  })

  it('ignores shift+wheel combined with ctrl/meta (zoom shortcuts)', () => {
    const { scrollable, child } = makeScrollable()
    renderHook(() => useShiftWheelHorizontalScroll())

    const result = dispatchWheel(child, { shiftKey: true, ctrlKey: true, deltaY: 40, deltaX: 0 })

    expect(result.defaultPrevented).toBe(false)
    expect(scrollable.scrollLeft).toBe(0)
    document.body.removeChild(scrollable)
  })

  it('leaves native horizontal deltas alone', () => {
    const { scrollable, child } = makeScrollable()
    renderHook(() => useShiftWheelHorizontalScroll())

    const result = dispatchWheel(child, { shiftKey: true, deltaY: 0, deltaX: 40 })

    expect(result.defaultPrevented).toBe(false)
    expect(scrollable.scrollLeft).toBe(0)
    document.body.removeChild(scrollable)
  })

  it('does nothing when no ancestor can scroll horizontally', () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    renderHook(() => useShiftWheelHorizontalScroll())

    const result = dispatchWheel(target, { shiftKey: true, deltaY: 40, deltaX: 0 })

    expect(result.defaultPrevented).toBe(false)
    document.body.removeChild(target)
  })
})
