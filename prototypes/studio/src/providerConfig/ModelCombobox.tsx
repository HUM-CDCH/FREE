import { useId, useRef, useState } from 'react'
import type { ProbeView } from './useProbeLifecycle'
import { providerFieldClass } from './ProviderConnectionCard'

type Props = {
  value: string
  onChange: (modelId: string) => void
  options: readonly { id: string; label: string }[]
  probePhase: ProbeView['phase']
  onOpen?: () => void
  ariaLabel: string
  disabled?: boolean
}

export function ModelCombobox({ value, onChange, options, probePhase, onOpen, ariaLabel, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [typing, setTyping] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)

  // Full list on open; substring filter only once the researcher starts typing.
  const filtered = typing && value ? options.filter((option) => option.id.toLowerCase().includes(value.toLowerCase())) : options

  function show(): void {
    setOpen(true)
    setTyping(false)
    setHighlighted(-1)
    onOpen?.()
  }

  function pick(modelId: string): void {
    onChange(modelId)
    setOpen(false)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      if (!open) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) return show()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setHighlighted((current) => (filtered.length === 0 ? -1 : (current + delta + filtered.length) % filtered.length))
      return
    }
    if (event.key === 'Enter' && open && highlighted >= 0 && filtered[highlighted]) {
      event.preventDefault()
      pick(filtered[highlighted].id)
    }
  }

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <input
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={
          open && highlighted >= 0
            ? `${listId}-option-${highlighted}`
            : undefined
        }
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        value={value}
        placeholder="Select or enter a model ID"
        className={`font-mono ${providerFieldClass}`}
        onFocus={show}
        onClick={show}
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
          setTyping(true)
          setHighlighted(-1)
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul id={listId} role="listbox" aria-label={`${ariaLabel} options`} className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-line bg-surface py-1 shadow-page">
          {probePhase === 'checking' && <li className="px-2.75 py-1.5 text-[11px] text-ink-faint">Loading models…</li>}
          {probePhase !== 'checking' && filtered.length === 0 && (
            <li className="px-2.75 py-1.5 text-[11px] text-ink-faint">
              {options.length === 0 ? 'No models listed for this connection. Enter an exact model ID.' : 'No matching models. The typed value is used as-is.'}
            </li>
          )}
          {filtered.map((option, index) => (
            <li
              id={`${listId}-option-${index}`}
              key={option.id}
              role="option"
              aria-selected={option.id === value}
              className={`cursor-pointer px-2.75 py-1.5 font-mono text-[12px] text-ink ${index === highlighted ? 'bg-surface-muted' : 'hover:bg-surface-muted'}`}
              onMouseDown={(event) => {
                event.preventDefault()
                pick(option.id)
              }}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
