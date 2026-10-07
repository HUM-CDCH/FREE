import { Children, type ReactNode, useId, useState } from 'react'

/** Small views share their owner's draft and preserve local edits when hidden. */
export function SettingsViews({ label, titles, children, selected }: {
  label: string
  titles: readonly string[]
  children: ReactNode
  /** Validation can reveal the view containing the first invalid setting. */
  selected?: string
}) {
  const [current, setCurrent] = useState(() => Math.max(0, selected ? titles.indexOf(selected) : 0))
  const [requested, setRequested] = useState(selected)
  if (requested !== selected) {
    setRequested(selected)
    const index = selected ? titles.indexOf(selected) : -1
    if (index >= 0) setCurrent(index)
  }
  const id = useId()
  const views = Children.toArray(children)
  if (views.length <= 1) return <>{views}</>
  const index = Math.min(current, views.length - 1)
  return (
    <div className="settings-views flex min-w-0 flex-col gap-3">
      <nav aria-label={label} className="flex min-w-0 items-center gap-2">
        <select aria-label={label} aria-controls={id} value={index} onChange={(event) => setCurrent(Number(event.target.value))}
          className="min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-[12px] font-semibold text-ink">
          {titles.map((title, at) => <option key={title} value={at}>{title}</option>)}
        </select>
        <span aria-live="polite" className="shrink-0 text-[11px] text-ink-faint"><span className="sr-only">{titles[index]} </span>{index + 1}/{views.length}</span>
        <button type="button" aria-label={`Previous ${label}`} disabled={index === 0} onClick={() => setCurrent(index - 1)}
          className="rounded border border-line px-2 py-1 text-ink disabled:opacity-40">‹</button>
        <button type="button" aria-label={`Next ${label}`} disabled={index === views.length - 1} onClick={() => setCurrent(index + 1)}
          className="rounded border border-line px-2 py-1 text-ink disabled:opacity-40">›</button>
      </nav>
      <div id={id}>
        {views.map((view, at) => <div key={titles[at]} hidden={at !== index}>{view}</div>)}
      </div>
    </div>
  )
}
