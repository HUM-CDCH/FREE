import { useEffect } from 'react'

function findHorizontalScrollTarget(target: EventTarget | null): HTMLElement | null {
  let node = target instanceof Element ? target : null
  while (node && node !== document.body && node !== document.documentElement) {
    if (node instanceof HTMLElement && node.scrollWidth > node.clientWidth) {
      const overflowX = getComputedStyle(node).overflowX
      if (overflowX === 'auto' || overflowX === 'scroll') return node
    }
    node = node.parentElement
  }
  return null
}

/**
 * Chrome converts Shift+wheel into horizontal scroll on the nearest
 * scrollable ancestor natively; Firefox and Safari don't reliably do the
 * same. Applying it explicitly here, once for the whole app shell, makes
 * every scrollable region (including the PDF viewer and the batch
 * extraction grid) behave the same way in every browser.
 */
export function useShiftWheelHorizontalScroll() {
  useEffect(() => {
    const controller = new AbortController()
    window.addEventListener(
      'wheel',
      (event) => {
        if (!event.shiftKey || event.ctrlKey || event.metaKey) return
        if (event.deltaY === 0 || event.deltaX !== 0) return
        const scrollable = findHorizontalScrollTarget(event.target)
        if (!scrollable) return
        event.preventDefault()
        scrollable.scrollLeft += event.deltaY
      },
      { signal: controller.signal, passive: false },
    )
    return () => controller.abort()
  }, [])
}
