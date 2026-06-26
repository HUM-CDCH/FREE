import type { ElementType, ReactNode } from 'react'

export type OverlineProps = {
  as?: ElementType
  children: ReactNode
  className?: string
}

/** Uppercase, letter-spaced section label (panel headers). */
function Overline({ as: Tag = 'span', children, className = '' }: OverlineProps) {
  return (
    <Tag className={`text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-muted ${className}`}>
      {children}
    </Tag>
  )
}

export default Overline
