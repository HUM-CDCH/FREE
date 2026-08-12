import { describe, expect, it } from 'vitest'
import { pickFloatingHighlightSide } from './floatingHighlight'

const bothFit = { aboveFits: true, belowFits: true } as const

describe('pickFloatingHighlightSide', () => {
  it('places the button at the drag end: below for a forward drag', () => {
    expect(pickFloatingHighlightSide({ dragUpward: false, ...bothFit })).toBe(
      'below',
    )
  })

  it('places the button at the drag end: above for an upward drag', () => {
    expect(pickFloatingHighlightSide({ dragUpward: true, ...bothFit })).toBe(
      'above',
    )
  })

  it('falls back to above when the below side does not fit', () => {
    expect(
      pickFloatingHighlightSide({
        dragUpward: false,
        aboveFits: true,
        belowFits: false,
      }),
    ).toBe('above')
  })

  it('falls back to below when the above side does not fit', () => {
    expect(
      pickFloatingHighlightSide({
        dragUpward: true,
        aboveFits: false,
        belowFits: true,
      }),
    ).toBe('below')
  })
})
