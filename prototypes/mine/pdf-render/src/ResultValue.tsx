import { useState } from 'react'
import { isRecord } from './template'

type ResultValueProps = {
  name: string
  value: unknown
  depth?: number
}

function MissingValue() {
  return (
    <span className="rounded-full border border-line-strong bg-surface-muted px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-faint">
      Missing
    </span>
  )
}

function PrimitiveRow({ name, value }: { name: string; value: unknown }) {
  const [expanded, setExpanded] = useState(false)
  const missing = value === null || value === undefined || value === ''
  const text = missing ? '' : String(value)
  const long = text.length > 160
  const display = long && !expanded ? `${text.slice(0, 160)}...` : text

  return (
    <div className="grid grid-cols-[minmax(6rem,38%)_minmax(0,1fr)] gap-3 border-t border-line px-3 py-2 first:border-t-0">
      <dt className="min-w-0 font-mono text-[11px] font-semibold text-ink-muted">{name}</dt>
      <dd className="min-w-0 text-[12px] leading-relaxed text-ink">
        {missing ? (
          <MissingValue />
        ) : (
          <>
            <span className="wrap-anywhere whitespace-pre-wrap">{display}</span>
            {long && (
              <button
                className="ml-2 cursor-pointer text-[11px] font-bold text-accent outline-none hover:underline focus-visible:underline"
                type="button"
                onClick={() => setExpanded((open) => !open)}
              >
                {expanded ? 'Less' : 'More'}
              </button>
            )}
          </>
        )}
      </dd>
    </div>
  )
}

function ArrayValue({ name, value, depth }: { name: string; value: readonly unknown[]; depth: number }) {
  const [expanded, setExpanded] = useState(true)
  const empty = value.length === 0

  return (
    <section className="rounded-lg border border-line bg-canvas">
      <button
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-2 text-left outline-none hover:bg-accent-ghost focus-visible:bg-accent-ghost"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        <span className="min-w-0 truncate font-mono text-[12px] font-semibold text-ink">{name}</span>
        <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[10.5px] font-semibold text-ink-muted">
          {value.length} item{value.length === 1 ? '' : 's'}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-line p-2">
          {empty ? (
            <div className="px-1 py-1">
              <MissingValue />
            </div>
          ) : (
            <ol className="flex flex-col gap-2">
              {value.map((item, index) => (
                <li key={`${name}-${index}`} className="rounded-md border border-line bg-surface">
                  <ResultValue name={`Item ${index + 1}`} value={item} depth={depth + 1} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  )
}

function ObjectValue({ name, value, depth }: { name: string; value: Record<string, unknown>; depth: number }) {
  const entries = Object.entries(value)

  return (
    <section className="rounded-lg border border-line bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
        <h3 className="min-w-0 truncate font-mono text-[12px] font-semibold text-ink">{name}</h3>
        <span className="shrink-0 text-[11px] text-ink-faint">
          {entries.length} field{entries.length === 1 ? '' : 's'}
        </span>
      </header>
      <div className="flex flex-col gap-2 p-2">
        {entries.length === 0 ? (
          <p className="px-1 py-1 text-[12px] text-ink-muted">No fields returned.</p>
        ) : (
          entries.map(([key, child]) => <ResultValue key={key} name={key} value={child} depth={depth + 1} />)
        )}
      </div>
    </section>
  )
}

function ResultValue({ name, value, depth = 0 }: ResultValueProps) {
  if (Array.isArray(value)) {
    return <ArrayValue name={name} value={value} depth={depth} />
  }
  if (isRecord(value)) {
    return <ObjectValue name={name} value={value} depth={depth} />
  }
  return <PrimitiveRow name={name} value={value} />
}

export default ResultValue
