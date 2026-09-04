import { useId, useState } from 'react'
import { extractionSchemaNameSchema } from '../shared/schemaRevision.contract'

type SchemaNameEditorProps = {
  name: string
  onSubmit: (name: string) => Promise<string | null>
  className?: string
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

/** A fixed-height schema-name control: entering edit mode never moves siblings. */
export default function SchemaNameEditor({
  name,
  onSubmit,
  className = '',
}: SchemaNameEditorProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const failureId = useId()
  const parsed = extractionSchemaNameSchema.safeParse(draft)

  if (!editing)
    return (
      <div className={`flex h-7 min-w-0 items-center gap-1 ${className}`}>
        <span className="truncate">{name}</span>
        <button
          className="shrink-0 rounded-md p-1 text-ink-muted outline-none transition-colors hover:bg-accent-soft hover:text-accent"
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
        if (!parsed.success) return
        setSaving(true)
        setFailure(null)
        const rejected = await onSubmit(parsed.data)
        setSaving(false)
        if (rejected) setFailure(rejected)
        else setEditing(false)
      }}
    >
      <input
        autoFocus
        className="h-7 min-w-0 flex-1 border-b border-line-strong bg-transparent p-0 font-[inherit] text-[inherit] outline-none focus-visible:border-accent disabled:opacity-60"
        aria-label={`Schema name for ${name}`}
        value={draft}
        disabled={saving}
        aria-invalid={!parsed.success}
        aria-describedby={failure ? failureId : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !saving) setEditing(false)
        }}
      />
      <button
        className="shrink-0 rounded-md p-1 leading-none text-accent outline-none hover:bg-accent-soft disabled:opacity-60"
        type="submit"
        aria-label="Save schema name"
        title="Save schema name"
        disabled={saving || !parsed.success}
      >
        <span aria-hidden="true">✓</span>
      </button>
      <button
        className="shrink-0 rounded-md p-1 leading-none text-ink-muted outline-none hover:bg-line/60 hover:text-ink disabled:opacity-60"
        type="button"
        aria-label="Cancel schema rename"
        title="Cancel schema rename"
        disabled={saving}
        onClick={() => setEditing(false)}
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
