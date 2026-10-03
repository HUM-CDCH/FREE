import { useState } from 'react'

/** "◀ 6 / 7 ▶": the number is an input; Enter or blur navigates when it names a page, otherwise it resets. It stays
 *  mounted, so focus survives a page change: the draft follows `page` unless the researcher is typing one. */
export default function PagePager({ page, pageCount, onNavigate }: { page: number; pageCount: number; onNavigate: (page: number) => void }) {
  const [draft, setDraft] = useState(String(page))
  const [focused, setFocused] = useState(false)
  // The page the draft was last set from; a draft that still names it is untouched.
  const [seenPage, setSeenPage] = useState(page)
  if (seenPage !== page) {
    setSeenPage(page)
    if (!focused || draft === String(seenPage)) setDraft(String(page))
  }
  const commit = () => {
    const next = Number.parseInt(draft, 10)
    if (Number.isInteger(next) && next >= 1 && next <= pageCount && next !== page) onNavigate(next)
    else setDraft(String(page))
  }
  const step = 'grid size-6 cursor-pointer place-items-center rounded-[3px] text-ink-muted outline-none transition-colors hover:bg-surface-muted hover:text-ink disabled:cursor-default disabled:opacity-40'
  return (
    <div className="flex items-center gap-1 text-compact text-ink-muted" role="group" aria-label="Page">
      <button type="button" className={step} aria-label="Previous page" disabled={page <= 1} onClick={() => onNavigate(page - 1)}>◀</button>
      <input
        aria-label="Current page"
        inputMode="numeric"
        className="h-6 w-9 rounded-[3px] border border-line bg-surface px-1 text-center tabular-nums text-ink outline-none focus:border-line-strong"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          commit()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
      />
      <span className="tabular-nums">/ {pageCount}</span>
      <button type="button" className={step} aria-label="Next page" disabled={page >= pageCount} onClick={() => onNavigate(page + 1)}>▶</button>
    </div>
  )
}
