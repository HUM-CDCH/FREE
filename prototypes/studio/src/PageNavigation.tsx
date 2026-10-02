import { useEffect, useRef } from 'react'

type PageNavigationProps = {
  id: string
  pageCount: number
  currentPage: number
  selectedPages: readonly number[]
  selecting: boolean
  selectionLimit: number
  onNavigate: (page: number) => void
  onTogglePage: (page: number) => void
  onClose: () => void
}

export function PageNavigation({
  id, pageCount, currentPage, selectedPages, selecting, selectionLimit,
  onNavigate, onTogglePage, onClose,
}: PageNavigationProps) {
  const pageButtons = useRef(new Map<number, HTMLButtonElement>())

  useEffect(() => {
    pageButtons.current.get(currentPage)?.parentElement?.scrollIntoView({ block: 'nearest' })
  }, [currentPage, selecting])

  return (
    <nav id={id} aria-label="Page navigation"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }}
      className="scrollbar-subtle z-20 w-28 shrink-0 overflow-y-auto overscroll-contain border-r border-line bg-surface-muted max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:shadow-lg">
      <ol className="flex flex-col items-center gap-3 px-3 py-3">
        {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => {
          const selected = selectedPages.includes(page)
          return (
            <li key={page} className="flex w-full flex-col items-center">
              <button type="button" aria-label={`Go to page ${page}`}
                aria-current={page === currentPage ? 'page' : undefined}
                aria-describedby={selected && !selecting ? `${id}-sample-${page}` : undefined}
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
                className={`h-20 w-16 rounded border bg-surface text-sm font-medium shadow-sm ${
                  selected ? 'border-accent text-accent' : 'border-line-strong text-ink-muted'} ${
                  page === currentPage ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface-muted' : ''}`}>
                {page}
              </button>
              {selecting ? (
                <label className="flex min-h-11 cursor-pointer items-center justify-center gap-1.5 text-[11px] text-ink-muted">
                  <input type="checkbox" checked={selected}
                    aria-label={selected ? `Remove page ${page} from the sample` : `Add page ${page} to the sample`}
                    tabIndex={page === currentPage ? 0 : -1}
                    disabled={!selected && selectedPages.length >= selectionLimit}
                    onChange={() => onTogglePage(page)}
                    className="size-4 accent-accent disabled:cursor-not-allowed" />
                  Sample
                </label>
              ) : selected && (
                <span id={`${id}-sample-${page}`} className="mt-1 text-[11px] font-semibold text-accent">Sample</span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
