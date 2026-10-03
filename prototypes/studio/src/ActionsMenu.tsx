import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export type ActionItem = {
  id: string
  label: string
  onSelect: () => void
  disabled?: boolean
  /** A danger item renders in red; `divider` draws a hairline above it. */
  tone?: 'danger'
  divider?: boolean
}

/** A "⋯" (or custom) trigger and a `role="menu"` list: arrow keys move between items (from the trigger, ArrowDown to the
 *  first and ArrowUp to the last), Escape closes and returns focus, a blur or a pointer press outside closes. Items only
 *  receive focus through the arrow keys, so the trigger keeps its place in the tab order. `align` names the trigger edge
 *  the list lines up with: `right` (the default) opens it leftwards, `left` rightwards, for a trigger near the left edge. */
export default function ActionsMenu({ label, items, trigger, triggerClassName = '', align = 'right' }: {
  label: string
  items: ActionItem[]
  trigger?: ReactNode
  triggerClassName?: string
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLUListElement>(null)
  const root = useRef<HTMLDivElement>(null)
  // A click does not focus a button in Safari, or in Firefox on macOS, so a blur alone would miss an outside press.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node | null)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])
  function close(returnFocus: boolean) {
    setOpen(false)
    if (returnFocus) button.current?.focus()
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!open) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const entries = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    const at = entries.findIndex((entry) => entry === document.activeElement)
    const next = at === -1
      ? (event.key === 'ArrowDown' ? 0 : entries.length - 1)
      : (at + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length
    entries[next]?.focus()
  }
  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) close(false)
      }}
    >
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`grid h-7 min-w-7 cursor-pointer place-items-center rounded-[3px] border border-line bg-surface px-1 text-ink-muted outline-none transition-colors hover:border-accent/50 hover:text-accent ${triggerClassName}`}
        onMouseDown={(event) => open && event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
      >
        {trigger ?? <span aria-hidden="true">⋯</span>}
      </button>
      {open && (
        <ul
          ref={menu}
          role="menu"
          aria-label={label}
          onMouseDown={(event) => event.preventDefault()}
          className={`absolute top-full z-30 mt-1 min-w-56 rounded-xl border border-line bg-surface py-1 shadow-float ${align === 'left' ? 'left-0' : 'right-0'}`}
        >
          {items.map((item) => (
            <li key={item.id} role="none" className={item.divider ? 'mt-1 border-t border-line pt-1' : ''}>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                className={`flex w-full items-center px-3 py-1.5 text-left text-secondary font-semibold outline-none hover:bg-surface-muted focus-visible:bg-surface-muted disabled:cursor-default disabled:opacity-50 ${
                  item.tone === 'danger' ? 'text-danger' : 'text-ink'
                }`}
                onClick={() => {
                  close(true)
                  item.onSelect()
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
