export type FloatingHighlightSide = 'above' | 'below'

export type FloatingHighlightSideOptions = {
  dragUpward: boolean
  aboveFits: boolean
  belowFits: boolean
}

export function pickFloatingHighlightSide({
  dragUpward,
  aboveFits,
  belowFits,
}: FloatingHighlightSideOptions): FloatingHighlightSide {
  let side: FloatingHighlightSide = dragUpward ? 'above' : 'below'
  if (side === 'below' && !belowFits) side = 'above'
  else if (side === 'above' && !aboveFits) side = 'below'
  return side
}
