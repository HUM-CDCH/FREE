import { useEffect, useRef } from 'react'

export type MenuItem = { label: string; onSelect: () => void; disabled?: string | null }

/** "More result actions" (results review redesign §8): a menu under ⋯; arrow keys move, Escape (the rail's) closes. */
export default function ResultsMenu({ items }: { items: readonly MenuItem[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus() }, [])
  function move(event: React.KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const entries = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    const at = entries.indexOf(document.activeElement as HTMLButtonElement)
    entries[(at + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length]?.focus()
  }
  return (
    <div ref={ref} role="menu" aria-label="More result actions" onKeyDown={move}
      className="absolute top-10 right-3 z-20 flex min-w-56 flex-col rounded-md border border-line bg-surface p-1 shadow-float">
      {items.map((item) => (
        <button key={item.label} type="button" role="menuitem" disabled={Boolean(item.disabled)} title={item.disabled ?? undefined}
          onClick={item.onSelect}
          className="cursor-pointer rounded px-2.5 py-1.5 text-left text-secondary text-ink outline-none hover:bg-surface-muted focus-visible:bg-surface-muted disabled:cursor-default disabled:text-ink-muted">
          {item.label}
        </button>
      ))}
    </div>
  )
}
