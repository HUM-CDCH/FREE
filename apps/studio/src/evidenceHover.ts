import { markValueId, ownsMark } from './durableRailModel'
import type { SelectionChannel } from './selectionChannel'

export type HoverChannel = Pick<SelectionChannel, 'subscribe' | 'snapshot'>
export type HoverTarget = { element: HTMLElement; keys: readonly string[] }

/** Hover is a paint-only channel. Index by retained value so a pointer move visits only its marks/rows, including
 *  parts and correction Evidence; notify only the elements whose lit state changed. Rebind after structural edits. */
export function observeEvidenceHover(channel: HoverChannel | undefined, targets: readonly HoverTarget[],
  options: { wholeValues?: boolean; change?: (element: HTMLElement, hovered: boolean) => void } = {}) {
  if (!channel) return () => {}
  const byValue = new Map<string, HoverTarget[]>()
  const change = options.change ?? ((element, hovered) => {
    if (element.classList.contains('hovered') !== hovered) element.classList.toggle('hovered', hovered)
  })
  let lit = new Set(targets.filter(({ element }) => element.classList.contains('hovered') || element.dataset.evidenceHovered === 'true').map(({ element }) => element))
  for (const target of targets) for (const id of new Set(target.keys.map(markValueId)))
    byValue.set(id, [...byValue.get(id) ?? [], target])
  let previous: readonly string[] | null | undefined
  let initial = true
  const sync = () => {
    const hovered = channel.snapshot().hover
    if (hovered === previous) return
    previous = hovered
    const next = new Set<HTMLElement>()
    for (const key of hovered ?? []) for (const target of byValue.get(markValueId(key)) ?? [])
      if (options.wholeValues || target.keys.some(each => ownsMark(key, each))) next.add(target.element)
    for (const element of lit) if (initial || !next.has(element)) change(element, next.has(element))
    for (const element of next) if (!lit.has(element)) change(element, true)
    lit = next
    initial = false
  }
  const unsubscribe = channel.subscribe(sync)
  sync()
  return unsubscribe
}
