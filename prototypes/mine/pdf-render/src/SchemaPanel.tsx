import { useEffect, useRef, useState } from 'react'
import type { AnnotationsMode } from './api'
import { countTemplateFields, isRecord } from './template'

export type TemplateState =
  | { status: 'idle' }
  | { status: 'generating'; raw: string }
  | { status: 'ready'; template: unknown; inputsKey: string }
  | { status: 'error'; message: string }

type SchemaPanelProps = {
  state: TemplateState
  stale: boolean
  onGenerate: () => void
  annotationCount: number
  annotationsMode: AnnotationsMode
  onAnnotationsModeChange: (mode: AnnotationsMode) => void
}

function TypeChip({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-none text-ink-muted">
      {label}
    </span>
  )
}

function FieldName({ name }: { name: string }) {
  return <span className="min-w-0 truncate text-[13px] font-medium text-ink">{name}</span>
}

function NestedFields({ value }: { value: Record<string, unknown> }) {
  return (
    <div className="ml-1.5 mt-1.5 border-l border-line pl-2.5">
      <TemplateFields template={value} />
    </div>
  )
}

function TemplateField({ name, value }: { name: string; value: unknown }) {
  if (Array.isArray(value)) {
    const first: unknown = value[0]
    if (isRecord(first)) {
      return (
        <li>
          <div className="flex items-center justify-between gap-2">
            <FieldName name={name} />
            <TypeChip label="list" />
          </div>
          <NestedFields value={first} />
        </li>
      )
    }
    return (
      <li className="flex items-center justify-between gap-2">
        <FieldName name={name} />
        <TypeChip label={`list of ${typeof first === 'string' ? first : 'values'}`} />
      </li>
    )
  }

  if (isRecord(value)) {
    return (
      <li>
        <FieldName name={name} />
        <NestedFields value={value} />
      </li>
    )
  }

  return (
    <li className="flex items-center justify-between gap-2">
      <FieldName name={name} />
      <TypeChip label={String(value)} />
    </li>
  )
}

function TemplateFields({ template }: { template: Record<string, unknown> }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {Object.entries(template).map(([name, value]) => (
        <TemplateField key={name} name={name} value={value} />
      ))}
    </ul>
  )
}

function StreamingOutput({ raw }: { raw: string }) {
  const preRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    const pre = preRef.current
    if (pre) {
      pre.scrollTop = pre.scrollHeight
    }
  }, [raw])

  return (
    <pre
      ref={preRef}
      className="scrollbar-subtle max-h-72 overflow-y-auto whitespace-pre-wrap wrap-break-word rounded-md border border-line bg-surface-muted p-2.5 font-mono text-[11px] leading-relaxed text-ink-muted"
      aria-live="polite"
    >
      {raw || 'Reading document…'}
    </pre>
  )
}

const generateButtonClasses =
  'inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-muted outline-none transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-accent focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:opacity-60 disabled:hover:border-line disabled:hover:bg-surface disabled:hover:text-ink-muted'

function AnnotationsModeToggle({
  mode,
  onChange,
}: {
  mode: AnnotationsMode
  onChange: (mode: AnnotationsMode) => void
}) {
  const segmentClasses = (active: boolean) =>
    `cursor-pointer px-2.5 py-1 text-[11px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
      active ? 'bg-ink text-canvas' : 'bg-surface text-ink-muted hover:text-ink'
    }`

  return (
    <div
      className="flex shrink-0 overflow-hidden rounded-md border border-line"
      role="group"
      aria-label="How highlights shape the schema"
    >
      <button
        className={segmentClasses(mode === 'hints')}
        type="button"
        aria-pressed={mode === 'hints'}
        title="Schema covers the whole document, highlights must be included"
        onClick={() => onChange('hints')}
      >
        Hints
      </button>
      <button
        className={segmentClasses(mode === 'fields')}
        type="button"
        aria-pressed={mode === 'fields'}
        title="Schema is built primarily from the highlights"
        onClick={() => onChange('fields')}
      >
        Fields
      </button>
    </div>
  )
}

function SchemaPanel({
  state,
  stale,
  onGenerate,
  annotationCount,
  annotationsMode,
  onAnnotationsModeChange,
}: SchemaPanelProps) {
  const [view, setView] = useState<'fields' | 'json'>('fields')
  const ready = state.status === 'ready'
  const fieldCount = ready ? countTemplateFields(state.template) : 0

  const tabClasses = (active: boolean) =>
    `cursor-pointer px-2.5 py-1 text-[11px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
      active ? 'bg-ink text-canvas' : 'bg-surface text-ink-muted hover:text-ink'
    }`

  return (
    <aside
      className="scrollbar-subtle flex max-h-80 min-h-0 flex-col border-b border-line bg-surface sm:max-h-none sm:w-85 sm:shrink-0 sm:border-b-0 sm:border-r"
      aria-label="Extraction schema"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            Extraction Schema
          </h2>
          <p className="truncate font-mono text-xs font-medium text-ink">
            Beretning_Ellekilde_8_13.pdf
          </p>
        </div>
        <div className="flex shrink-0 overflow-hidden rounded-md border border-line">
          <button
            className={tabClasses(view === 'fields')}
            type="button"
            aria-pressed={view === 'fields'}
            onClick={() => setView('fields')}
          >
            Fields
          </button>
          <button
            className={`${tabClasses(view === 'json')} font-mono`}
            type="button"
            aria-pressed={view === 'json'}
            onClick={() => setView('json')}
          >
            {'{ }'}
          </button>
        </div>
      </header>

      <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {state.status === 'idle' && (
          <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center">
            <p className="text-[13px] font-semibold text-ink">No schema yet</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              FREE produces the extraction schema from the document with the extraction model.
            </p>
            {annotationCount > 0 && (
              <div className="mt-3 flex items-center justify-center gap-2">
                <span className="text-[11px] text-ink-faint">Use highlights as</span>
                <AnnotationsModeToggle mode={annotationsMode} onChange={onAnnotationsModeChange} />
              </div>
            )}
            <button className={`${generateButtonClasses} mt-3`} type="button" onClick={onGenerate}>
              Generate schema
            </button>
          </div>
        )}

        {state.status === 'generating' && <StreamingOutput raw={state.raw} />}

        {state.status === 'error' && (
          <div className="rounded-xl border border-dashed border-danger/40 px-4 py-6 text-center">
            <p className="text-[13px] leading-snug text-danger">{state.message}</p>
            <button className={`${generateButtonClasses} mt-3`} type="button" onClick={onGenerate}>
              Retry
            </button>
          </div>
        )}

        {state.status === 'ready' &&
          (view === 'json' ? (
            <pre className="overflow-x-auto whitespace-pre rounded-md border border-line bg-surface-muted p-2.5 font-mono text-[11px] leading-relaxed text-ink">
              {JSON.stringify(state.template, null, 2)}
            </pre>
          ) : isRecord(state.template) ? (
            <TemplateFields template={state.template} />
          ) : (
            <pre className="scrollbar-subtle max-h-72 overflow-y-auto whitespace-pre-wrap wrap-break-word rounded-md border border-line bg-surface-muted p-2.5 font-mono text-[11px] leading-relaxed text-ink-muted">
              {String(state.template)}
            </pre>
          ))}
      </div>

      <footer className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-t border-line px-4 py-2">
        <p className="text-[11px] leading-snug text-ink-faint">
          {state.status === 'generating' && (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-amber-500" />
              Producing schema from the document…
            </span>
          )}
          {state.status === 'ready' &&
            (stale ? (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-amber-500" />
                Highlights changed — regenerate to update the schema
              </span>
            ) : (
              `${fieldCount} field${fieldCount === 1 ? '' : 's'} · produced from the document · read-only`
            ))}
          {state.status === 'idle' && 'Generate to produce the schema from the document'}
          {state.status === 'error' && 'Generation failed'}
        </p>
        {ready && (
          <div className="flex shrink-0 items-center gap-2">
            {annotationCount > 0 && (
              <AnnotationsModeToggle mode={annotationsMode} onChange={onAnnotationsModeChange} />
            )}
            <button className={generateButtonClasses} type="button" onClick={onGenerate}>
              Regenerate
            </button>
          </div>
        )}
      </footer>
    </aside>
  )
}

export default SchemaPanel
