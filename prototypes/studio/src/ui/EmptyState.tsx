import type { ReactNode } from 'react'

export type EmptyStateProps = {
  /** Optional glyph/icon shown above the title. */
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  tone?: 'neutral' | 'danger'
  /** Action(s) rendered below the copy, e.g. a Button. */
  children?: ReactNode
  className?: string
}

function EmptyState({ icon, title, description, tone = 'neutral', children, className = '' }: EmptyStateProps) {
  const border = tone === 'danger' ? 'border-danger/40' : 'border-line'
  return (
    <div
      className={`rounded-xl border border-dashed ${border} px-4 py-7 text-center ${className}`}
    >
      {icon && (
        <p aria-hidden="true" className="text-lg leading-none text-ink-muted">
          {icon}
        </p>
      )}
      <h2 className={`${icon ? 'mt-2 ' : ''}text-[13px] font-semibold ${tone === 'danger' ? 'text-danger' : 'text-ink'}`}>
        {title}
      </h2>
      {description && <p className="mt-1 text-xs leading-relaxed text-ink-muted">{description}</p>}
      {children && <div className="mt-3 flex items-center justify-center gap-2">{children}</div>}
    </div>
  )
}

export default EmptyState
