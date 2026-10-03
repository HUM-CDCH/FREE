export type Segment<T extends string> = {
  value: T
  label: React.ReactNode
  /** Optional title/tooltip for the segment. */
  title?: string
}

export type SegmentedControlProps<T extends string> = {
  options: ReadonlyArray<Segment<T>>
  value: T
  onChange: (value: T) => void
  /** Accessible label for the group. */
  'aria-label'?: string
  className?: string
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className = '',
  ...rest
}: SegmentedControlProps<T>) {
  return (
    <div
      className={`flex shrink-0 overflow-hidden rounded-[3px] border border-line ${className}`}
      role="group"
      aria-label={rest['aria-label']}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            className={`min-h-6 cursor-pointer px-2.5 py-1 text-compact font-semibold outline-none transition-colors ${
              active ? 'bg-ink text-canvas' : 'bg-surface text-ink-muted hover:text-ink'
            }`}
            type="button"
            aria-pressed={active}
            title={option.title}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export default SegmentedControl
