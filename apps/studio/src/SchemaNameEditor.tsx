import { useId, useRef, useState } from 'react'
import { extractionSchemaNameSchema } from '../shared/schemaRevision.contract'

type SchemaNameEditorProps = {
  name: string
  onSubmit: (name: string) => Promise<string | null>
  className?: string
  /** The element the static name renders as: `h2` where the name is a panel's heading. */
  nameAs?: 'span' | 'h2'
}

function PencilIcon() {
  return (
    <svg
      aria-hidden="true"
      width="13"
      height="13"
      viewBox="0 0 20 20"
      fill="currentColor"
    >
      <path d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793 3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
    </svg>
  )
}

/** A fixed-height schema-name control: entering edit mode never moves siblings. Escape and Cancel close it at any time,
 *  also while a rename is saving or waiting its turn: that rename goes on, and the name shown follows its answer. */
export default function SchemaNameEditor({
  name,
  onSubmit,
  className = '',
  nameAs: Name = 'span',
}: SchemaNameEditorProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const failureId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  /** Counts closed editing sessions: a rename left saving by Escape or Cancel answers into a later session otherwise. */
  const session = useRef(0)
  const parsed = extractionSchemaNameSchema.safeParse(draft)
  const close = () => {
    session.current += 1
    setSaving(false)
    setEditing(false)
  }

  if (!editing)
    return (
      <div className={`group flex h-7 min-w-0 items-center gap-1 text-content font-semibold text-ink ${className}`}>
        <Name className="truncate">{name}</Name>
        <button
          className="grid size-6 shrink-0 place-items-center rounded-md text-ink-muted opacity-0 outline-none transition-colors hover:bg-surface-muted hover:text-ink group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
          type="button"
          aria-label={`Rename schema ${name}`}
          title="Rename schema"
          onClick={() => {
            setDraft(name)
            setFailure(null)
            setEditing(true)
          }}
        >
          <PencilIcon />
        </button>
      </div>
    )

  return (
    <form
      className={`relative flex h-7 min-w-0 items-center gap-1 ${className}`}
      onSubmit={async (event) => {
        event.preventDefault()
        if (!parsed.success || saving) return
        const submitted = session.current
        setSaving(true)
        setFailure(null)
        // Save is disabled while saving; the focus waits in the name, where Escape reaches the editor.
        inputRef.current?.focus()
        const rejected = await onSubmit(parsed.data)
        if (submitted !== session.current) return
        setSaving(false)
        if (rejected) setFailure(rejected)
        else setEditing(false)
      }}
    >
      <input
        ref={inputRef}
        autoFocus
        className="h-7 min-w-0 flex-1 border-b border-line-strong bg-transparent p-0 font-[inherit] text-[inherit] outline-none focus-visible:border-accent read-only:opacity-60"
        aria-label={`Schema name for ${name}`}
        value={draft}
        readOnly={saving}
        aria-busy={saving}
        aria-invalid={!parsed.success}
        aria-describedby={failure ? failureId : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close()
        }}
      />
      <button
        className="grid size-6 shrink-0 place-items-center rounded-md leading-none text-green outline-none hover:bg-green-soft disabled:opacity-60"
        type="submit"
        aria-label="Save schema name"
        title="Save schema name"
        disabled={saving || !parsed.success}
      >
        <span aria-hidden="true">✓</span>
      </button>
      <button
        className="grid size-6 shrink-0 place-items-center rounded-md leading-none text-ink-muted outline-none hover:bg-line/60 hover:text-ink disabled:opacity-60"
        type="button"
        aria-label="Cancel schema rename"
        title="Cancel schema rename"
        onClick={close}
      >
        <span aria-hidden="true">×</span>
      </button>
      {failure && (
        <p
          id={failureId}
          className="absolute left-0 top-full z-20 mt-1 max-w-72 rounded-md border border-danger/30 bg-surface px-2 py-1 text-[11px] font-normal leading-snug text-danger shadow-float"
          role="alert"
        >
          {failure}
        </p>
      )}
    </form>
  )
}
