export type AnnotationSetItem = {
  id: string
  label: string
  pageNumber: number
}

type AnnotationSetTabProps = {
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

function AnnotationSetTab({ items, onSelectItem, onRemoveItem }: AnnotationSetTabProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-9.5 shrink-0 items-center gap-2.5 border-b border-line px-4">
        <h2 className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-muted">
          Annotation set
        </h2>
      </header>

      <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-3.5 py-3.5">
        {items.length === 0 ? (
          <div className="mt-1.5 rounded-xl border border-dashed border-line-strong px-4 py-6 text-center">
            <p aria-hidden="true" className="text-[21px] leading-none text-ink-muted">
              ✎
            </p>
            <p className="mt-2 text-[13.5px] font-semibold text-ink">Annotate the source</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              Select any passage in the report to add it to the annotation set.
            </p>
          </div>
        ) : (
          groupByPage(items).map((group) => (
            <section key={group.pageNumber} className="mb-3.5 last:mb-0">
              <h3 className="mb-1.5 px-0.5 text-[10px] font-bold uppercase tracking-widest text-ink-muted">
                Page {group.pageNumber}
              </h3>
              <ul className="flex flex-wrap gap-1.5">
                {group.items.map((item) => (
                  <li key={item.id} className="max-w-full">
                    <span className="inline-flex h-6.5 max-w-full items-center overflow-hidden rounded-full border border-accent bg-accent-soft transition-colors has-focus-visible:ring-2 has-focus-visible:ring-accent/40">
                      <button
                        className="h-full min-w-0 max-w-52.5 cursor-pointer truncate pl-2.5 pr-1 text-left font-serif text-xs italic text-ink outline-none transition-colors hover:text-ev"
                        type="button"
                        title={`Go to highlight on page ${item.pageNumber}: ${item.label}`}
                        onClick={() => onSelectItem(item.id)}
                      >
                        “{item.label}”
                      </button>
                      <button
                        className="flex h-full w-6 shrink-0 cursor-pointer items-center justify-center text-sm leading-none text-ink-muted outline-none transition-colors hover:text-accent focus-visible:text-accent"
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
    </div>
  )
}

export default AnnotationSetTab
