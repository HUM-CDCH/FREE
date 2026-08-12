// import { EmptyState } from './ui'
import type { AnnotationsMode } from './api'

export type AnnotationSetItem = {
  id: string
  label: string
  pageNumber: number
}

type Props = {
  items: AnnotationSetItem[]
  onSelectItem: (id: string) => void
  onRemoveItem: (id: string) => void
  annotationsMode: AnnotationsMode
  onAnnotationsModeChange: (mode: AnnotationsMode) => void
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

function AnnotationsModeToggle({ mode, onChange }: { mode: AnnotationsMode; onChange: (mode: AnnotationsMode) => void }) {
  const seg = (active: boolean) =>
    `cursor-pointer px-2.5 py-1 text-[11px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${active ? 'bg-ink text-canvas' : 'bg-surface text-ink-muted hover:text-ink'}`
  return (
    <div className="flex shrink-0 overflow-hidden rounded-md border border-line" role="group" aria-label="How highlights shape the schema">
      <button className={seg(mode === 'hints')} type="button" aria-pressed={mode === 'hints'} onClick={() => onChange('hints')}>Hints</button>
      <button className={seg(mode === 'fields')} type="button" aria-pressed={mode === 'fields'} onClick={() => onChange('fields')}>Fields</button>
    </div>
  )
}

function AnnotationSidebar({ items, onSelectItem, onRemoveItem, annotationsMode, onAnnotationsModeChange }: Props) {
  return (
    <aside className="scrollbar-subtle flex h-full min-h-0 flex-col overflow-y-auto" aria-label="Annotation set">
      {items.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3.5 py-2.5">
          <span className="text-[11px] text-ink-faint">Use highlights as</span>
          <AnnotationsModeToggle mode={annotationsMode} onChange={onAnnotationsModeChange} />
        </div>
      )}
      <div className="px-3.5 py-4">
        {items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-7 text-center">
            <p aria-hidden="true" className="text-lg leading-none text-ink-muted">✎</p>
            <p className="mt-2 text-[13px] font-semibold text-ink">Annotate the source</p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
              Select a passage and press Highlight to add it to the annotation set.
            </p>
          </div>
        ) : (
          groupByPage(items).map((group) => (
            <section key={group.pageNumber} className="mb-3.5 last:mb-0">
              <h3 className="mb-1.5 px-0.5 text-[11px] font-bold uppercase tracking-[0.1em] text-ink-muted">
                Page {group.pageNumber}
              </h3>
              <ul className="flex flex-col gap-2.5">
                {group.items.map((item) => (
                  <li key={item.id} className="flex max-w-full flex-col items-start gap-1.5">
                    <span className="inline-flex h-6.5 max-w-full items-center overflow-hidden rounded-full border border-accent bg-accent-soft transition-colors has-focus-visible:ring-2 has-focus-visible:ring-accent/40">
                      <button
                        className="h-full min-w-0 max-w-52.5 cursor-pointer truncate pl-2.5 pr-1 text-left font-serif text-[13px] italic text-ink outline-none transition-colors hover:text-accent"
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
