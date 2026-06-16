export type AnnotationSetItem = {
  id: string
  label: string
  pageNumber: number
}

export type ExtractionState =
  | { status: 'extracting' }
  | { status: 'done'; result: unknown; decision: 'pending' | 'confirmed' | 'rejected' }
  | { status: 'error'; message: string }

type Props = {
  items: AnnotationSetItem[]
  onSelectItem: (id: string) => void
  onRemoveItem: (id: string) => void
}

type Group = { pageNumber: number; items: AnnotationSetItem[] }

function groupByPage(items: AnnotationSetItem[]): Group[] {
  const groups: Group[] = []
  for (const item of items) {
    const last = groups[groups.length - 1]
    if (last && last.pageNumber === item.pageNumber) last.items.push(item)
    else groups.push({ pageNumber: item.pageNumber, items: [item] })
  }
  return groups
}

function AnnotationSidebar({ items, onSelectItem, onRemoveItem }: Props) {
  return (
    <aside className="scrollbar-subtle flex h-full min-h-0 flex-col overflow-y-auto" aria-label="Annotation set">
      <div className="px-3.5 py-4">
        {items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-7 text-center">
            <p aria-hidden="true" className="text-lg leading-none text-ink-muted">✎</p>
            <p className="mt-2 text-[13px] font-semibold text-ink">Annotate the source</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              Select any passage in the report — it becomes a grounded annotation in the set.
            </p>
          </div>
        ) : (
          groupByPage(items).map((group) => (
            <section key={group.pageNumber} className="mb-3.5 last:mb-0">
              <h3 className="mb-1.5 px-0.5 text-[10px] font-bold uppercase tracking-[0.1em] text-ink-muted">
                Page {group.pageNumber}
              </h3>
              <ul className="flex flex-col gap-2.5">
                {group.items.map((item) => (
                  <li key={item.id} className="flex max-w-full flex-col items-start gap-1.5">
                    <span className="inline-flex h-6.5 max-w-full items-center overflow-hidden rounded-full border border-accent bg-accent-soft transition-colors has-focus-visible:ring-2 has-focus-visible:ring-accent/40">
                      <button
                        className="h-full min-w-0 max-w-52.5 cursor-pointer truncate pl-2.5 pr-1 text-left font-serif text-xs italic text-ink outline-none transition-colors hover:text-accent"
                        type="button"
                        title={`Go to highlight on page ${item.pageNumber}: ${item.label}`}
                        onClick={() => onSelectItem(item.id)}
                      >
                        "{item.label}"
                      </button>
                      <button
                        className="flex h-full w-6 shrink-0 cursor-pointer items-center justify-center text-sm leading-none text-ink-muted outline-none transition-colors hover:text-danger focus-visible:text-danger"
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
