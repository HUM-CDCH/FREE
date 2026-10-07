import { useEffect, useRef, useState } from 'react'
import type { ThumbnailRenderer } from './PageThumbnails'

export const THUMBNAIL_WIDTH = 46
export const THUMBNAIL_HEIGHT = 58

type PageNavigationProps = {
  id: string
  pageCount: number
  currentPage: number
  onNavigate: (page: number) => void
  onClose: () => void
  /** Renders a page's thumbnail; null until the document has loaded (cards then show their numbers only). */
  thumbnails: ThumbnailRenderer | null
}

function ThumbnailCanvas({ page, current, thumbnails, visible }: {
  page: number
  current: boolean
  thumbnails: ThumbnailRenderer | null
  visible: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'pending' | 'drawn' | 'unavailable'>('pending')
  useEffect(() => {
    if (!visible || !thumbnails || state !== 'pending') return
    let cancelled = false
    void thumbnails.render(page).then((bitmap) => {
      if (cancelled) return
      const context = bitmap ? canvasRef.current?.getContext('2d') : null
      if (!bitmap || !context) {
        setState('unavailable')
        return
      }
      try {
        // Fit the page inside the card, keeping its aspect ratio, centred.
        const scale = Math.min(THUMBNAIL_WIDTH / bitmap.width, THUMBNAIL_HEIGHT / bitmap.height)
        const width = bitmap.width * scale
        const height = bitmap.height * scale
        context.drawImage(bitmap, (THUMBNAIL_WIDTH - width) / 2, (THUMBNAIL_HEIGHT - height) / 2, width, height)
        setState('drawn')
      } catch {
        // A closed or detached bitmap: the card shows its number on a blank thumbnail.
        setState('unavailable')
      }
    })
    return () => {
      cancelled = true
    }
  }, [page, state, thumbnails, visible])
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      width={THUMBNAIL_WIDTH}
      height={THUMBNAIL_HEIGHT}
      data-thumbnail={state}
      // The current-page mark is a 2px ink border, which the global :focus-visible ring (outline + box-shadow) never
      // overrides; the other cards' 1px border plus 1px margin keeps every card the same size.
      className={`block rounded-[2px] bg-surface shadow-sm ${current ? 'border-2 border-ink' : 'm-px border border-line-strong'}`}
    />
  )
}

/** The page rail: a thumbnail card per page, rendered lazily while the rail is open and the page is within one rail
 *  height of view. The current page's thumbnail carries a 2px ink border; the keyboard model is a roving tab stop with arrows, Home and End. */
export function PageNavigation({ id, pageCount, currentPage, onNavigate, onClose, thumbnails }: PageNavigationProps) {
  const pageButtons = useRef(new Map<number, HTMLButtonElement>())
  const navRef = useRef<HTMLElement>(null)
  // Without IntersectionObserver (tests) every page counts as in view.
  const [visible, setVisible] = useState<ReadonlySet<number>>(() =>
    typeof IntersectionObserver === 'undefined' ? new Set(Array.from({ length: pageCount }, (_, index) => index + 1)) : new Set(),
  )

  useEffect(() => {
    pageButtons.current.get(currentPage)?.parentElement?.scrollIntoView({ block: 'nearest' })
  }, [currentPage])

  useEffect(() => {
    const nav = navRef.current
    if (!nav || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((current) => {
          const next = new Set(current)
          for (const entry of entries) if (entry.isIntersecting) next.add(Number((entry.target as HTMLElement).dataset.page))
          return next.size === current.size ? current : next
        })
      },
      { root: nav, rootMargin: `${nav.clientHeight}px 0px` },
    )
    nav.querySelectorAll<HTMLElement>('[data-page]').forEach((item) => observer.observe(item))
    return () => observer.disconnect()
  }, [pageCount])

  return (
    <nav
      id={id}
      ref={navRef}
      aria-label="Page navigation"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }}
      className="scrollbar-subtle z-20 w-[76px] shrink-0 overflow-y-auto overscroll-contain border-r border-line bg-surface-muted max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:shadow-lg"
    >
      <ol className="flex flex-col items-center gap-2 px-1 py-2">
        {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => (
          <li key={page} data-page={page} className="flex w-full flex-col items-center">
            <button
              type="button"
              aria-label={`Go to page ${page}`}
              aria-current={page === currentPage ? 'page' : undefined}
              tabIndex={page === currentPage ? 0 : -1}
              ref={(button) => {
                if (button) pageButtons.current.set(page, button)
                else pageButtons.current.delete(page)
              }}
              onClick={() => onNavigate(page)}
              onKeyDown={(event) => {
                const nextPage = event.key === 'ArrowDown' ? Math.min(pageCount, page + 1)
                  : event.key === 'ArrowUp' ? Math.max(1, page - 1)
                    : event.key === 'Home' ? 1 : event.key === 'End' ? pageCount : null
                if (nextPage !== null) {
                  event.preventDefault()
                  onNavigate(nextPage)
                  pageButtons.current.get(nextPage)?.focus()
                }
              }}
              className="flex w-[62px] cursor-pointer flex-col items-center gap-1 rounded-[3px] p-1 outline-none transition-colors hover:bg-accent-ghost"
            >
              <ThumbnailCanvas page={page} current={page === currentPage} thumbnails={thumbnails} visible={visible.has(page)} />
              <span className="text-compact tabular-nums text-ink-muted">{page}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}
