/** Reveal a linked item without moving the workspace or an adjacent pane. */
export function scrollWithinPane(container: HTMLElement, element: HTMLElement) {
  const view = container.getBoundingClientRect(), target = element.getBoundingClientRect()
  if (!view.width || !view.height) return
  if (target.top >= view.top && target.bottom <= view.bottom && target.left >= view.left && target.right <= view.right) return
  const deltaY = target.top - view.top - Math.max(8, (view.height - target.height) / 2)
  const deltaX = target.left - view.left - Math.max(0, (view.width - target.width) / 2)
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  container.scrollTo({
    top: container.scrollTop + deltaY,
    left: container.scrollLeft + deltaX,
    // Long jumps land at once; only a short hop glides. This also avoids
    // competing with pdf.js rendering pages on the way to distant Evidence.
    behavior: reducedMotion || Math.abs(deltaY) > view.height || Math.abs(deltaX) > view.width ? 'auto' : 'smooth',
  })
}
