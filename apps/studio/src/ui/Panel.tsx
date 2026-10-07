import type { ReactNode } from 'react'

export type PanelProps = {
  header?: ReactNode
  footer?: ReactNode
  children: ReactNode
  /** Override the body classes (e.g. full-bleed bodies that scroll themselves). */
  bodyClassName?: string
  className?: string
}

/** Full-height column with optional bordered header/footer and a scrolling body. */
function Panel({
  header,
  footer,
  children,
  bodyClassName = 'scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-4 py-3',
  className = '',
}: PanelProps) {
  return (
    <div className={`flex h-full min-h-0 flex-col ${className}`}>
      {header && (
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          {header}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
      {footer && (
        <footer className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-t border-line px-4 py-2">
          {footer}
        </footer>
      )}
    </div>
  )
}

export default Panel
