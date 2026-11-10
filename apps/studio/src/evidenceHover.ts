import { markValueId, ownsMark } from './durableRailModel'
import type { SelectionChannel } from './selectionChannel'

/** Each surface refreshes after structural changes. Hover changes classes only; it never renders React or measures
 * geometry. Read the current DOM rather than maintaining an index of pdf.js's disposable page children. */
export function observeEvidenceHover(channel: SelectionChannel, roots: readonly (HTMLElement | null | undefined)[], wholeValues = false) {
  let previous: readonly string[] | null | undefined
  const sync = () => {
    const hovered = channel.snapshot().hover
    if (hovered === previous) return
    previous = hovered
    for (const root of roots) for (const element of root?.querySelectorAll<HTMLElement>('[data-hover-keys]') ?? []) {
      const keys = JSON.parse(element.dataset.hoverKeys!) as string[]
      const lit = hovered?.some(key => keys.some(each => wholeValues ? markValueId(key) === markValueId(each) : ownsMark(key, each))) ?? false
      element.classList.toggle('hovered', lit)
    }
  }
  const unsubscribe = channel.subscribe(sync)
  sync()
  return unsubscribe
}
