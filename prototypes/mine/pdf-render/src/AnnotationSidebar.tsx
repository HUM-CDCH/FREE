import { useState } from 'react'

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
  extractions: Record<string, ExtractionState>
  onSelectItem: (id: string) => void
  onRemoveItem: (id: string) => void
  onExtractItem: (id: string) => void
  onDecideExtraction: (id: string, decision: 'pending' | 'confirmed' | 'rejected', editedResult?: unknown) => void
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

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function AnnotationSidebar({ items, extractions, onSelectItem, onRemoveItem, onExtractItem, onDecideExtraction }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  function startEdit(id: string, result: unknown) {
    setEditingId(id)
    setEditValue(stringify(result))
  }

  function saveEdit(id: string) {
    let parsed: unknown
    try { parsed = JSON.parse(editValue) } catch { parsed = editValue }
    onDecideExtraction(id, 'confirmed', parsed)
    setEditingId(null)
  }

  const pendingIds = items.filter((item) => !extractions[item.id]).map((item) => item.id)
  const anyExtracting = items.some((item) => extractions[item.id]?.status === 'extracting')

  return (
    <aside className="scrollbar-subtle flex h-full min-h-0 flex-col overflow-y-auto" aria-label="Annotation set">
      {items.length > 0 && (
        <div className="flex shrink-0 items-center justify-end border-b border-line px-3.5 py-2">
          <button
            className="cursor-pointer rounded px-2.5 py-1 text-[11px] font-medium text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent disabled:cursor-default disabled:opacity-40"
            type="button"
            disabled={pendingIds.length === 0 || anyExtracting}
            onClick={() => pendingIds.forEach((id) => onExtractItem(id))}
          >
            {anyExtracting ? 'Extracting…' : `Extract${pendingIds.length > 1 ? ` (${pendingIds.length})` : ''}`}
          </button>
        </div>
      )}
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
                {group.items.map((item) => {
                  const ext = extractions[item.id]
                  const isEditing = editingId === item.id

                  return (
                    <li key={item.id} className="flex max-w-full flex-col items-start gap-1.5">
                      <span className="inline-flex h-6.5 max-w-full items-center overflow-hidden rounded-full border border-accent bg-accent-soft transition-colors has-focus-visible:ring-2 has-focus-visible:ring-accent/40">
                        <button
                          className="h-full min-w-0 max-w-52.5 cursor-pointer truncate pl-2.5 pr-1 text-left font-serif text-xs italic text-ink outline-none transition-colors hover:text-accent"
                          type="button"
                          title={`Go to highlight on page ${item.pageNumber}: ${item.label}`}
                          onClick={() => onSelectItem(item.id)}
                        >
                          “{item.label}”
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

                      {ext?.status === 'extracting' && (
                        <div className="w-full rounded-lg border border-line bg-surface px-2 py-2">
                          <p className="animate-pulse text-[11px] text-ink-faint">Extracting…</p>
                        </div>
                      )}

                      {ext?.status === 'error' && (
                        <div className="w-full rounded-lg border border-line bg-surface px-2 py-2">
                          <p className="text-[11px] text-danger">{ext.message}</p>
                          <button className="mt-1 text-[11px] text-ink-muted underline hover:text-accent" type="button" onClick={() => onExtractItem(item.id)}>
                            Retry
                          </button>
                        </div>
                      )}

                      {ext?.status === 'done' && ext.decision === 'pending' && (
                        <div className="w-full rounded-lg border border-line bg-surface px-2 py-2">
                          {isEditing ? (
                            <>
                              <textarea
                                className="w-full rounded border border-line bg-canvas p-1.5 font-mono text-[11px] text-ink outline-none focus:border-accent"
                                rows={6}
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                              />
                              <div className="mt-1.5 flex gap-1.5">
                                <button className="cursor-pointer rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-white hover:bg-accent/80" type="button" onClick={() => saveEdit(item.id)}>Save</button>
                                <button className="cursor-pointer rounded px-2 py-0.5 text-[11px] text-ink-muted hover:text-ink" type="button" onClick={() => setEditingId(null)}>Cancel</button>
                              </div>
                            </>
                          ) : (
                            <>
                              <pre className="overflow-x-auto rounded bg-canvas p-1.5 text-[11px] text-ink">{stringify(ext.result)}</pre>
                              <div className="mt-1.5 flex gap-1.5">
                                <button className="cursor-pointer rounded bg-emerald-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-600" type="button" onClick={() => onDecideExtraction(item.id, 'confirmed')}>✓ Accept</button>
                                <button className="cursor-pointer rounded border border-line px-2 py-0.5 text-[11px] text-ink-muted hover:border-accent/50 hover:text-accent" type="button" onClick={() => startEdit(item.id, ext.result)}>Edit</button>
                                <button className="cursor-pointer rounded px-2 py-0.5 text-[11px] text-ink-faint hover:text-danger" type="button" onClick={() => onDecideExtraction(item.id, 'rejected')}>✗ Reject</button>
                              </div>
                            </>
                          )}
                        </div>
                      )}

                      {ext?.status === 'done' && ext.decision !== 'pending' && (
                        <div className="w-full rounded-lg border border-line bg-surface px-2 py-1.5">
                          <p className="text-[11px] text-ink-faint">
                            {ext.decision === 'confirmed'
                              ? <span className="text-emerald-600">✓ Extraction confirmed</span>
                              : <span className="text-danger">✗ Extraction rejected</span>}
                            <button className="ml-2 underline hover:text-ink-muted" type="button" onClick={() => onDecideExtraction(item.id, 'pending')}>undo</button>
                          </p>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </aside>
  )
}

export default AnnotationSidebar
