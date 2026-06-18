import { useState } from 'react'
import type { AnnotationsMode } from './api'
import {
  FIELD_TYPES,
  addTemplateField,
  countTemplateFields,
  fieldTypeLabel,
  isRecord,
  patchTemplateField,
  removeTemplateField,
} from './template'
import type { TemplatePath } from './template'

export type TemplateState =
  | { status: 'idle' }
  | { status: 'generating' }
  | { status: 'ready'; template: unknown; inputsKey: string; edited?: boolean }
  | { status: 'error'; message: string }

type SchemaPanelProps = {
  state: TemplateState
  stale: boolean
  onGenerate: () => void
  onTemplateChange: (template: unknown, message: string) => void
  annotationCount: number
  annotationsMode: AnnotationsMode
  onAnnotationsModeChange: (mode: AnnotationsMode) => void
}

type FieldEditing = {
  pathKey: string
  name: string
  type: string
}

type FieldEditorProps = {
  editing: FieldEditing | null
  onStartEdit: (path: TemplatePath, name: string, type: string) => void
  onEditingChange: (editing: FieldEditing) => void
  onSaveEdit: (path: TemplatePath) => void
  onCancelEdit: () => void
  onRemove: (path: TemplatePath, name: string) => void
}

function pathKey(path: TemplatePath) {
  return path.join('\0')
}

function TypeChip({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 font-mono text-[10px] font-medium leading-none text-ink-muted">
      {label}
    </span>
  )
}

function FieldName({ name }: { name: string }) {
  return <span className="min-w-0 truncate font-mono text-[12.5px] font-medium text-ink">{name}</span>
}

function typeOptions(current: string) {
  const options: string[] = [...FIELD_TYPES]
  if (!options.includes(current)) {
    options.unshift(current)
  }
  return options
}

function FieldEditForm({
  path,
  editing,
  onEditingChange,
  onSaveEdit,
  onCancelEdit,
}: {
  path: TemplatePath
  editing: FieldEditing
  onEditingChange: (editing: FieldEditing) => void
  onSaveEdit: (path: TemplatePath) => void
  onCancelEdit: () => void
}) {
  return (
    <div className="my-0.5 flex flex-col gap-1.5 rounded-lg border border-accent bg-accent-ghost px-2.5 py-2">
      <input
        className="min-w-0 rounded-md border border-line-strong bg-surface px-2 py-1 font-mono text-xs font-semibold text-ink outline-none focus-visible:border-accent"
        value={editing.name}
        placeholder="field_name"
        autoFocus
        onChange={(event) => onEditingChange({ ...editing, name: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            onSaveEdit(path)
          }
          if (event.key === 'Escape') {
            onCancelEdit()
          }
        }}
      />
      <div className="flex items-center gap-1.5">
        <select
          className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-1.5 py-1 font-mono text-[11px] text-ink outline-none focus-visible:border-accent"
          value={editing.type}
          onChange={(event) => onEditingChange({ ...editing, type: event.target.value })}
        >
          {typeOptions(editing.type).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <button
          className="shrink-0 cursor-pointer rounded-md border border-accent bg-accent px-2.5 py-1 text-[11.5px] font-bold text-white outline-none transition-[filter] hover:brightness-108"
          type="button"
          onClick={() => onSaveEdit(path)}
        >
          Save
        </button>
        <button
          className="shrink-0 cursor-pointer rounded-md border border-line-strong bg-surface px-2 py-1 text-[11.5px] font-semibold text-ink-muted outline-none transition-colors hover:text-accent"
          type="button"
          title="Cancel"
          onClick={onCancelEdit}
        >
          ✕
        </button>
      </div>
    </div>
  )
}

function FieldActions({
  path,
  name,
  type,
  editor,
}: {
  path: TemplatePath
  name: string
  type: string
  editor: FieldEditorProps
}) {
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <button
        className="cursor-pointer px-1 text-[11px] leading-none text-ink-faint outline-none transition-colors hover:text-accent focus-visible:text-accent"
        type="button"
        title={`Edit field: ${name}`}
        onClick={() => editor.onStartEdit(path, name, type)}
      >
        ✎
      </button>
      <button
        className="cursor-pointer px-1 text-[10px] leading-none text-ink-faint outline-none transition-colors hover:text-accent focus-visible:text-accent"
        type="button"
        title={`Remove field: ${name}`}
        onClick={() => editor.onRemove(path, name)}
      >
        ✕
      </button>
    </span>
  )
}

function NestedFields({ value, path, editor }: { value: Record<string, unknown>; path: TemplatePath; editor: FieldEditorProps }) {
  return (
    <div className="ml-1.5 mt-1.5 border-l border-line pl-2.5">
      <TemplateFields template={value} path={path} editor={editor} />
    </div>
  )
}

function TemplateField({
  name,
  value,
  path,
  editor,
}: {
  name: string
  value: unknown
  path: TemplatePath
  editor: FieldEditorProps
}) {
  const type = fieldTypeLabel(value)

  if (editor.editing?.pathKey === pathKey(path)) {
    return (
      <li>
        <FieldEditForm
          path={path}
          editing={editor.editing}
          onEditingChange={editor.onEditingChange}
          onSaveEdit={editor.onSaveEdit}
          onCancelEdit={editor.onCancelEdit}
        />
      </li>
    )
  }

  const rowClasses = '-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent-ghost'

  if (Array.isArray(value)) {
    const first: unknown = value[0]
    if (isRecord(first)) {
      return (
        <li>
          <div className={rowClasses}>
            <FieldName name={name} />
            <TypeChip label="list" />
            <span className="min-w-0 flex-1" />
            <FieldActions path={path} name={name} type={type} editor={editor} />
          </div>
          <NestedFields value={first} path={path} editor={editor} />
        </li>
      )
    }
    return (
      <li className={rowClasses}>
        <FieldName name={name} />
        <TypeChip label={`list of ${typeof first === 'string' ? first : 'values'}`} />
        <span className="min-w-0 flex-1" />
        <FieldActions path={path} name={name} type={type} editor={editor} />
      </li>
    )
  }

  if (isRecord(value)) {
    return (
      <li>
        <div className={rowClasses}>
          <FieldName name={name} />
          <span className="min-w-0 flex-1" />
          <FieldActions path={path} name={name} type={type} editor={editor} />
        </div>
        <NestedFields value={value} path={path} editor={editor} />
      </li>
    )
  }

  return (
    <li className={rowClasses}>
      <FieldName name={name} />
      <TypeChip label={String(value)} />
      <span className="min-w-0 flex-1" />
      <FieldActions path={path} name={name} type={type} editor={editor} />
    </li>
  )
}

function TemplateFields({
  template,
  path,
  editor,
}: {
  template: Record<string, unknown>
  path: TemplatePath
  editor: FieldEditorProps
}) {
  return (
    <ul className="flex flex-col gap-1">
      {Object.entries(template).map(([name, value]) => (
        <TemplateField key={name} name={name} value={value} path={[...path, name]} editor={editor} />
      ))}
    </ul>
  )
}

function WorkingIndicator() {
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-md border border-line bg-canvas px-4 py-8 text-center"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className="animate-spin-slow size-7 rounded-full border-[3px] border-line border-t-accent"
      />
      <p className="text-[13px] font-semibold text-ink">Producing schema…</p>
      <p className="max-w-[34ch] text-xs leading-snug text-ink-muted">
        This can take a while on large documents.
      </p>
    </div>
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
  onTemplateChange,
  annotationCount,
  annotationsMode,
  onAnnotationsModeChange,
}: SchemaPanelProps) {
  const [view, setView] = useState<'fields' | 'json'>('fields')
  const [editing, setEditing] = useState<FieldEditing | null>(null)
  const ready = state.status === 'ready'
  const template = ready ? state.template : null
  const fieldCount = ready ? countTemplateFields(state.template) : 0

  function startEdit(path: TemplatePath, name: string, type: string) {
    setEditing({ pathKey: pathKey(path), name, type })
  }

  function saveEdit(path: TemplatePath) {
    if (!editing || !ready) {
      return
    }
    const name = editing.name.trim().toLowerCase().replace(/\s+/g, '_')
    if (!name) {
      setEditing(null)
      return
    }
    onTemplateChange(patchTemplateField(state.template, path, name, editing.type), '✎ Schema updated')
    setEditing(null)
  }

  function removeField(path: TemplatePath) {
    if (!ready) {
      return
    }
    setEditing(null)
    onTemplateChange(removeTemplateField(state.template, path), 'Field removed from schema')
  }

  function addField() {
    if (!ready || !isRecord(state.template)) {
      return
    }
    let name = 'nyt_felt'
    let suffix = 2
    while (name in state.template) {
      name = `nyt_felt_${suffix++}`
    }
    onTemplateChange(addTemplateField(state.template, name, 'verbatim-string'), '✎ Schema updated')
    setView('fields')
    setEditing({ pathKey: pathKey([name]), name, type: 'verbatim-string' })
  }

  const editor: FieldEditorProps = {
    editing,
    onStartEdit: startEdit,
    onEditingChange: setEditing,
    onSaveEdit: saveEdit,
    onCancelEdit: () => setEditing(null),
    onRemove: removeField,
  }

  const tabClasses = (active: boolean) =>
    `cursor-pointer px-2.5 py-1 text-[11px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
      active ? 'bg-ink text-canvas' : 'bg-surface text-ink-muted hover:text-ink'
    }`

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-muted">
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
          <div className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center">
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

        {state.status === 'generating' && <WorkingIndicator />}

        {state.status === 'error' && (
          <div className="rounded-xl border border-dashed border-danger/40 px-4 py-6 text-center">
            <p className="text-[13px] leading-snug text-danger">{state.message}</p>
            <button className={`${generateButtonClasses} mt-3`} type="button" onClick={onGenerate}>
              Retry
            </button>
          </div>
        )}

        {ready &&
          (view === 'json' ? (
            <pre className="overflow-x-auto whitespace-pre rounded-md border border-line bg-canvas p-2.5 font-mono text-[11px] leading-relaxed text-ink">
              {JSON.stringify(template, null, 2)}
            </pre>
          ) : isRecord(template) ? (
            <>
              <TemplateFields template={template} path={[]} editor={editor} />
              <button
                className="mt-2.5 block w-full cursor-pointer rounded-lg border-[1.5px] border-dashed border-line-strong bg-transparent py-2 text-xs font-semibold text-ink-muted outline-none transition-colors hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:text-accent"
                type="button"
                onClick={addField}
              >
                + Add field
              </button>
            </>
          ) : (
            <pre className="scrollbar-subtle max-h-72 overflow-y-auto whitespace-pre-wrap wrap-break-word rounded-md border border-line bg-canvas p-2.5 font-mono text-[11px] leading-relaxed text-ink-muted">
              {String(template)}
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
          {ready &&
            (stale ? (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-amber-500" />
                Highlights changed — regenerate to update the schema
              </span>
            ) : (
              `${fieldCount} field${fieldCount === 1 ? '' : 's'} · produced from the document${
                state.edited ? ' · edited by you' : ''
              }`
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
    </div>
  )
}

export default SchemaPanel
