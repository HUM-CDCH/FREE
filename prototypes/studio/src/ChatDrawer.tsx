import type { ReactNode, RefObject } from 'react'

export type ChatDrawerProps = {
  open: boolean
  onCollapse: () => void
  onExpand: () => void
  title: string
  /** A command in the header, e.g. "Generate schema" before a schema exists. */
  headerAction?: ReactNode
  /** While collapsed, marks the composer: an open conversation or an earlier request still running. */
  dot?: { title: string } | null
  /** Sticky controls between the conversation and the composer, e.g. the proposal's Apply / Discard bar. */
  bar?: ReactNode
  composer: ReactNode
  /** The conversation's scroll container, for keeping the newest message in view. */
  bodyRef?: RefObject<HTMLDivElement | null>
  children: ReactNode
}

/** The rail's conversation: a composer line at rest; sending opens a drawer of 40% of the rail with the conversation,
 *  a header and a collapse chevron. Collapsing hides, never discards. */
export default function ChatDrawer({ open, onCollapse, onExpand, title, headerAction, dot, bar, composer, bodyRef, children }: ChatDrawerProps) {
  return (
    <div className={`flex shrink-0 flex-col border-t border-line bg-surface-muted ${open ? 'h-[40%] min-h-48' : ''}`}>
      {open && (
        <section aria-label="Conversation" className="flex min-h-0 flex-1 flex-col">
          {/* At the 264px rail the title gives way (truncates) and the actions keep their width. */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3.5 py-1.5">
            <span className="min-w-0 truncate text-overline font-bold uppercase tracking-[0.12em] text-ink-muted" title={title}>{title}</span>
            <div className="flex shrink-0 items-center gap-1.5">
              {headerAction}
              <button type="button" aria-label="Collapse conversation" title="Collapse"
                className="grid size-6 cursor-pointer place-items-center rounded-[3px] text-ink-muted outline-none hover:text-accent" onClick={onCollapse}>
                <span aria-hidden="true">⌄</span>
              </button>
            </div>
          </div>
          <div ref={bodyRef} className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-3.5 py-2.5">{children}</div>
          {bar}
        </section>
      )}
      <div className="flex shrink-0 items-center gap-2 px-3.5 pb-3 pt-1.5">
        {!open && dot && (
          <button type="button" aria-label={dot.title} title={dot.title}
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-full outline-none hover:bg-surface" onClick={onExpand}>
            <span aria-hidden="true" className="size-2 rounded-full bg-accent" />
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-2.5 py-1.5">{composer}</div>
      </div>
    </div>
  )
}
