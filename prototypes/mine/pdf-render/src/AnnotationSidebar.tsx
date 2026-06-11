export type AnnotationSetItem = {
  id: string
  label: string
  pageNumber: number
}

type AnnotationSidebarProps = {
  items: AnnotationSetItem[]
  onSelectItem: (id: string) => void
  onRemoveItem: (id: string) => void
}

function AnnotationSidebar({ items, onSelectItem, onRemoveItem }: AnnotationSidebarProps) {
  return (
    <aside
      className="scrollbar-subtle max-h-36 min-h-0 overflow-y-auto border-b border-line bg-surface sm:max-h-none sm:border-b-0 sm:border-r"
      aria-label="Annotation set"
    >
      <header className="sticky top-0 z-10 flex min-h-10 items-center gap-2.5 border-b border-line bg-surface px-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
          Annotation Set
        </h2>
        <span
          className="inline-grid h-4.5 min-w-5.5 place-items-center rounded-full bg-accent-soft px-1.5 text-[11px] font-semibold leading-none text-accent tabular-nums"
          aria-label={`${items.length} annotations`}
        >
          {items.length}
        </span>
      </header>

      <section className="px-4 py-3 sm:px-3.5 sm:py-4" aria-labelledby="annotation-set-title">
        <h3
          id="annotation-set-title"
          className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint"
        >
          Baggrund og udgravning
        </h3>
        {items.length === 0 ? (
          <p className="mt-2.5 text-[13px] leading-snug text-ink-faint">
            Select text in the document to create a highlight.
          </p>
        ) : (
          <ul className="mt-2.5 flex flex-wrap gap-2">
            {items.map((item) => (
              <li key={item.id}>
                <span className="inline-flex h-6.5 max-w-full items-center overflow-hidden rounded-full border border-line bg-surface text-xs font-medium text-ink transition-colors hover:border-accent/50 hover:bg-accent-soft has-focus-visible:border-accent has-focus-visible:ring-2 has-focus-visible:ring-accent/40">
                  <button
                    className="h-full min-w-0 max-w-47.5 cursor-pointer truncate pl-2.5 pr-1.5 text-left outline-none transition-colors hover:text-accent"
                    type="button"
                    title={`Go to highlight on page ${item.pageNumber}: ${item.label}`}
                    onClick={() => onSelectItem(item.id)}
                  >
                    {item.label}
                  </button>
                  <button
                    className="flex h-full w-6 shrink-0 cursor-pointer items-center justify-center text-sm leading-none text-ink-faint outline-none transition-colors hover:bg-danger/10 hover:text-danger"
                    type="button"
                    aria-label={`Remove highlight: ${item.label}`}
                    title={`Remove highlight: ${item.label}`}
                    onClick={() => onRemoveItem(item.id)}
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}

export default AnnotationSidebar
