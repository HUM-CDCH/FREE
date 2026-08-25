import type { ComponentPropsWithRef } from 'react'

type Variant = 'primary' | 'secondary' | 'pill'
type Size = 'sm' | 'md'

export type ButtonProps = ComponentPropsWithRef<'button'> & {
  /** Visual weight: terracotta `primary`, outline `secondary`, or rounded `pill`. */
  variant?: Variant
  size?: Size
}

const base =
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 font-semibold outline-none transition-colors disabled:cursor-default disabled:opacity-60'

const variants: Record<Variant, string> = {
  primary:
    'rounded-[3px] border border-accent bg-accent text-white transition-[filter] hover:brightness-108 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:border-line disabled:bg-line disabled:text-ink-muted',
  secondary:
    'rounded-[3px] border border-line bg-surface text-ink-muted hover:border-accent/50 hover:text-accent focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40',
  pill:
    'rounded-full border border-line bg-surface text-ink-muted hover:border-accent/50 hover:bg-accent-soft hover:text-accent focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 disabled:hover:border-line disabled:hover:bg-surface disabled:hover:text-ink-muted',
}

const sizes: Record<Size, string> = {
  sm: 'px-2.5 py-1 text-[11px]',
  md: 'px-4 py-2 text-[12.5px] font-bold',
}

function Button({ variant = 'secondary', size = 'sm', className = '', type, ...props }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  )
}

export default Button
