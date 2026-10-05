import { type KeyboardEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react'

export type PickerOption = { value: string; label: string; hint?: string; disabled?: boolean }
export type PickerGroup = {
  key: string
  label: string
  /** Shown before the label: the connection's probe status. */
  status?: ReactNode
  /** One faint line under the label: "Listing models…", or why the listing failed. */
  note?: string
  options: PickerOption[]
  /** Offers the typed text as a value of this group: a model ID its connection did not list. */
  freeText?: (typed: string) => string
}

type Row = { id: string; value: string; disabled: boolean }

const TRIGGER_CLASS =
  'flex w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-line-strong bg-canvas px-2.75 py-2 text-left text-[12.5px] text-ink transition-colors hover:border-ink-muted disabled:cursor-default disabled:opacity-60'

/**
 * One control for "which model": options grouped by where they run, a search box and, in a group that accepts one,
 * the typed text as an exact model ID. Arrows move, Enter picks, Escape closes and returns focus to the trigger.
 */
export function ModelPicker({
  ariaLabel,
  value,
  display,
  groups,
  reset,
  onChange,
}: {
  ariaLabel: string
  value: string
  display: ReactNode
  groups: PickerGroup[]
  reset?: { value: string; label: string }
  onChange(value: string): void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const baseId = useId()
  const typed = query.trim()
  const search = typed.toLowerCase()

  useLayoutEffect(() => {
    const button = trigger.current
    const popup = menu.current
    if (!open || !button || !popup) return

    // Keep the menu out of the dialog's flow: opening it must not create a scrollbar or move the header/footer.
    function position(): void {
      if (!button || !popup) return
      const anchor = button.getBoundingClientRect()
      const dialog = button.closest('dialog')?.getBoundingClientRect()
      const left = Math.max(8, dialog?.left ?? 0)
      const right = Math.min(window.innerWidth - 8, dialog?.right ?? window.innerWidth)
      const top = 8
      const bottom = window.innerHeight - 8
      const width = Math.min(Math.max(anchor.width, 288), right - left)
      popup.style.width = `${width}px`
      popup.style.left = `${Math.max(left, Math.min(anchor.left, right - width))}px`
      popup.style.maxHeight = ''
      const height = popup.getBoundingClientRect().height
      const below = Math.max(0, bottom - anchor.bottom - 4)
      const above = Math.max(0, anchor.top - top - 4)
      const dialogBelow = Math.max(0, Math.min(bottom, dialog?.bottom ?? bottom) - anchor.bottom - 4)
      const dialogAbove = Math.max(0, anchor.top - Math.max(top, dialog?.top ?? top) - 4)
      const upward = height > dialogBelow && dialogAbove > dialogBelow
      const available = upward ? above : below
      popup.style.maxHeight = `${available}px`
      popup.style.top = `${upward ? anchor.top - 4 - Math.min(height, available) : anchor.bottom + 4}px`
    }

    position()
    popup.querySelector('input')?.focus({ preventScroll: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position)
    observer?.observe(popup)
    observer?.observe(button)
    const dialog = button.closest('dialog')
    if (dialog) observer?.observe(dialog)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])

  const resetRow: Row | null = reset && !search ? { id: `${baseId}-reset`, value: reset.value, disabled: false } : null
  const shown = groups.flatMap((group, groupIndex) => {
    const options = group.options
      .map((option, index) => ({ ...option, id: `${baseId}-${groupIndex}-${index}`, disabled: option.disabled === true }))
      .filter((option) => !search || option.label.toLowerCase().includes(search))
    const free: Row | null =
      group.freeText && typed && !group.options.some((option) => option.label === typed)
        ? { id: `${baseId}-${groupIndex}-typed`, value: group.freeText(typed), disabled: false }
        : null
    if (search && options.length === 0 && !free) return []
    return [{ group, groupIndex, options, free }]
  })
  const choosable = [resetRow, ...shown.flatMap(({ options, free }) => [...options, free])].filter(
    (row): row is Row => row !== null && !row.disabled,
  )

  function show(): void {
    setOpen(true)
    setActive(choosable.find((row) => row.value === value)?.id ?? null)
  }

  function close(returnFocus: boolean): void {
    setOpen(false)
    setQuery('')
    setActive(null)
    if (returnFocus) trigger.current?.focus()
  }

  function choose(row: Row): void {
    if (row.disabled) return
    onChange(row.value)
    close(true)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      // Handled here, so an enclosing dialog does not also take it as its own dismissal.
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (choosable.length === 0) return
      const at = choosable.findIndex((row) => row.id === active)
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = at === -1 ? (step === 1 ? 0 : choosable.length - 1) : (at + step + choosable.length) % choosable.length
      setActive(choosable[next].id)
      document.getElementById(choosable[next].id)?.scrollIntoView?.({ block: 'nearest' })
      return
    }
    if (event.key === 'Enter') {
      const row = choosable.find((item) => item.id === active)
      if (!row) return
      event.preventDefault()
      choose(row)
    }
  }

  return (
    <div
      className="relative min-w-0"
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) close(false)
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-describedby={`${baseId}-value`}
        // While open, a press on the trigger closes it; keeping focus in the search box stops the blur reopening it.
        onMouseDown={(event) => open && event.preventDefault()}
        onClick={() => (open ? close(true) : show())}
        className={TRIGGER_CLASS}
      >
        <span id={`${baseId}-value`} className="min-w-0 truncate">{display}</span>
        <span aria-hidden="true" className="text-[10px] text-ink-faint">▾</span>
      </button>
      {open && (
        <div ref={menu} className="fixed z-30 flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-float">
          <input
            role="combobox"
            aria-label={`Search ${ariaLabel}`}
            aria-expanded="true"
            aria-controls={`${baseId}-list`}
            aria-autocomplete="list"
            aria-activedescendant={active ?? undefined}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(null)
            }}
            onKeyDown={onKeyDown}
            placeholder={groups.some((group) => group.freeText) ? 'Search, or type an exact model ID' : 'Search models'}
            className="w-full shrink-0 border-b border-line bg-surface px-3 py-2 text-[12px] text-ink outline-none placeholder:text-ink-faint"
          />
          {/* Clicks inside keep focus in the search box, so the list stays open until a row is picked. */}
          <ul
            id={`${baseId}-list`}
            role="listbox"
            aria-label={ariaLabel}
            onMouseDown={(event) => event.preventDefault()}
            className="min-h-0 max-h-72 overflow-auto overscroll-contain py-1"
          >
            {resetRow && (
              <PickerRow row={resetRow} value={value} active={active} onPick={choose}>
                <span className="text-ink-muted">{reset?.label}</span>
              </PickerRow>
            )}
            {shown.map(({ group, groupIndex, options, free }) => {
              const heading = `${baseId}-${groupIndex}-heading`
              const note = `${baseId}-${groupIndex}-note`
              return (
                <li key={group.key} role="presentation" className="mt-1 first:mt-0">
                  <ul role="group" aria-labelledby={heading} aria-describedby={group.note ? note : undefined}>
                    <li
                      role="presentation"
                      id={heading}
                      className="flex items-center gap-1.5 px-3 pt-1.5 pb-1 text-[10.5px] font-bold tracking-[0.08em] text-ink-faint uppercase"
                    >
                      {group.status}
                      {group.label}
                    </li>
                    {group.note && (
                      <li role="presentation" id={note} className="px-3 pb-1 text-[11px] whitespace-pre-line text-ink-faint">{group.note}</li>
                    )}
                    {options.map((item) => (
                      <PickerRow key={item.id} row={item} value={value} active={active} onPick={choose}>
                        <span className="min-w-0 font-mono text-[12px] break-all">{item.label}</span>
                        {item.hint && <> <span className="ml-1 shrink-0 text-[10.5px] text-ink-faint">{item.hint}</span></>}
                      </PickerRow>
                    ))}
                    {free && (
                      <PickerRow row={free} value={value} active={active} onPick={choose}>
                        <span className="min-w-0 break-all">
                          <span className="text-ink-muted">Use</span> <span className="font-mono text-[12px]">{typed}</span>
                        </span>
                      </PickerRow>
                    )}
                  </ul>
                </li>
              )
            })}
            {!resetRow && shown.length === 0 && (
              <li role="presentation" className="px-3 py-1.5 text-[11.5px] text-ink-faint">
                {search ? 'No models match.' : 'No models to choose from.'}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

/** One choosable row; a disabled one is shown and never picked. */
function PickerRow({
  row,
  value,
  active,
  onPick,
  children,
}: {
  row: Row
  /** The picker's current value: its row is marked selected. */
  value: string
  /** The row the keyboard is on. */
  active: string | null
  onPick: (row: Row) => void
  children: ReactNode
}) {
  const selected = row.value === value
  return (
    <li
      id={row.id}
      role="option"
      aria-selected={selected}
      aria-disabled={row.disabled || undefined}
      onClick={() => onPick(row)}
      className={`flex items-center gap-1 px-3 py-1.5 text-left text-[12.5px] ${selected ? 'text-accent' : 'text-ink'} ${
        row.disabled ? 'cursor-default opacity-45' : 'cursor-pointer hover:bg-surface-muted'
      } ${row.id === active ? 'bg-surface-muted' : ''}`}
    >
      <span aria-hidden="true" className="w-3 shrink-0 text-[10px] text-accent">{selected ? '✓' : ''}</span>
      {children}
    </li>
  )
}
