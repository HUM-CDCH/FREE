import { markValueId, ownsMark } from './durableRailModel'
import type { SelectionChannel } from './selectionChannel'

/** Each surface binds its current elements after structural changes. A hover visits only the retained values it
 * names, including parts and correction Evidence; React and PDF painting do not participate in pointer movement. */
export function observeEvidenceHover(channel: SelectionChannel, roots: readonly (HTMLElement | null | undefined)[], wholeValues = false) {
  const byValue = new Map<string, { element: HTMLElement; keys: string[] }[]>()
  const targets = roots.flatMap(root => [...root?.querySelectorAll<HTMLElement>('[data-hover-keys]') ?? []])
  for (const element of targets) {
    const keys = JSON.parse(element.dataset.hoverKeys!) as string[]
    for (const id of new Set(keys.map(markValueId))) {
      const entries = byValue.get(id) ?? []
      entries.push({ element, keys }); byValue.set(id, entries)
    }
  }
  let lit = new Set(targets.filter(element => element.classList.contains('hovered')))
  let previous: readonly string[] | null | undefined
  const sync = () => {
    const hovered = channel.snapshot().hover
    if (hovered === previous) return
    previous = hovered
    const next = new Set<HTMLElement>()
    for (const key of hovered ?? []) for (const target of byValue.get(markValueId(key)) ?? [])
      if (wholeValues || target.keys.some(each => ownsMark(key, each))) next.add(target.element)
    for (const element of lit) if (!next.has(element)) element.classList.remove('hovered')
    for (const element of next) if (!lit.has(element)) element.classList.add('hovered')
    lit = next
  }
  const unsubscribe = channel.subscribe(sync)
  sync()
  return unsubscribe
}
