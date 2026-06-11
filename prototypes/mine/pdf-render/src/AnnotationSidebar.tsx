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

type AnnotationGroup = {
  pageNumber: number
  items: AnnotationSetItem[]
}

// Items arrive sorted by page, so adjacent runs form the position groups.
function groupByPage(items: AnnotationSetItem[]): AnnotationGroup[] {
  const groups: AnnotationGroup[] = []
  for (const item of items) {
    const last = groups[groups.length - 1]
    if (last && last.pageNumber === item.pageNumber) {
      last.items.push(item)
    } else {
      groups.push({ pageNumber: item.pageNumber, items: [item] })
    }
  }
  return groups
}

function AnnotationSidebar({ items, onSelectItem, onRemoveItem }: AnnotationSidebarProps) {
  return (
    <aside
      className="scrollbar-subtle max-h-72 min-h-0 overflow-y-auto border-t border-line bg-surface sm:max-h-none sm:w-75 sm:shrink-0 sm:border-t-0 sm:border-l"
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

      <div className="px-4 py-3 sm:px-3.5 sm:py-4">
        {items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-7 text-center">
            <p aria-hidden="true" className="text-lg leading-none text-ink-muted">
              ✎
            </p>
            <p className="mt-2 text-[13px] font-semibold text-ink">Annotate the source</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              Select any passage in the report — it becomes a grounded annotation in the set.
            </p>
          </div>
        ) : (
          groupByPage(items).map((group) => (
            <section key={group.pageNumber} className="mb-4 last:mb-0">
              <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-ink-faint">
                Page {group.pageNumber}
              </h3>
              <ul className="flex flex-wrap gap-1.5">
                {group.items.map((item) => (
                  <li key={item.id} className="max-w-full">
                    <span className="inline-flex h-6.5 max-w-full items-center overflow-hidden rounded-full border border-line bg-surface text-xs font-medium text-ink transition-colors hover:border-accent/50 hover:bg-accent-soft has-focus-visible:border-accent has-focus-visible:ring-2 has-focus-visible:ring-accent/40">
                      <button
                        className="h-full min-w-0 max-w-47.5 cursor-pointer truncate pl-2.5 pr-1.5 text-left italic outline-none transition-colors hover:text-accent"
                        type="button"
                        title={`Go to highlight on page ${item.pageNumber}: ${item.label}`}
                        onClick={() => onSelectItem(item.id)}
                      >
                        “{item.label}”
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
            </section>
          ))
        )}
      </div>
    </aside>
  )
}

export default AnnotationSidebar
