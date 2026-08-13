import { useEffect, useRef, useState } from 'react'
import type { NavigableRoute } from '../projectNavigation'
import { projectContextNameSchema } from '../../shared/projectContext.contract'
import { Button, EmptyState } from '../ui'
import { useProjectContexts, type WriteResult } from './useProjectContexts'

export type ProjectContextPageProps = {
  projectContextId: string
  onNavigate: (route: NavigableRoute) => void
}

/**
 * The inline rename form. It keeps the typed name and shows a retryable
 * failure in place; only an acknowledged write closes it.
 */
function RenameForm({
  initialName,
  onSubmit,
  onCancel,
}: {
  initialName: string
  onSubmit: (name: string) => WriteResult
  onCancel: () => void
}) {
  const [name, setName] = useState(initialName)
  const [failure, setFailure] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // The shared contract decides, so the field never narrows it: a name that
  // trims down to the limit stays submittable however it was typed.
  const named = projectContextNameSchema.safeParse(name)

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (event) => {
        event.preventDefault()
        if (!named.success) return
        setSaving(true)
        setFailure(null)
        const rejected = await onSubmit(named.data)
        // A success unmounts this form; a failure keeps the typed name.
        if (rejected) {
          setSaving(false)
          setFailure(rejected.message)
        }
      }}
    >
      <input
        autoFocus
        className="h-7 min-w-0 max-w-md flex-1 border-b border-line-strong bg-transparent px-0 py-0 text-lg font-bold leading-7 text-ink outline-none focus-visible:border-accent disabled:opacity-60"
        aria-label="Project Context name"
        value={name}
        disabled={saving}
        aria-invalid={!named.success}
        aria-describedby={failure ? 'rename-project-context-error' : undefined}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !saving) onCancel()
        }}
      />
      {failure && (
        <p
          id="rename-project-context-error"
          className="basis-full text-[11px] leading-snug text-danger"
          role="alert"
        >
          {failure}
        </p>
      )}
      <button
        className="rounded-md p-1.5 leading-none text-accent outline-none transition-colors hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
        type="submit"
        aria-label="Rename"
        title="Rename"
        disabled={saving || !named.success}
      >
        <span aria-hidden="true">✓</span>
      </button>
      <button
        className="rounded-md p-1.5 leading-none text-ink-muted outline-none transition-colors hover:bg-line/60 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
        type="button"
        aria-label="Cancel"
        title="Cancel"
        onClick={onCancel}
        disabled={saving}
      >
        <span aria-hidden="true">×</span>
      </button>
    </form>
  )
}

/** Permanent deletion is confirmed in a labelled modal, never on one click. */
function DeleteDialog({
  name,
  onConfirm,
  onCancel,
}: {
  name: string
  onConfirm: () => WriteResult
  onCancel: () => void
}) {
  const [failure, setFailure] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)

  // Native modality owns focus: `showModal` moves focus in and contains Tab.
  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  return (
    <dialog
      ref={dialog}
      className="m-auto w-full max-w-sm rounded-lg border border-line bg-surface p-5 text-ink backdrop:bg-ink/55 backdrop:backdrop-blur-[2px]"
      aria-labelledby="delete-project-context-title"
      aria-describedby="delete-project-context-description"
      onClose={onCancel}
      // Escape and every other dismissal wait for a write in flight, so a
      // failure keeps the dialog and its retry.
      onCancel={(event) => {
        event.preventDefault()
        if (!deleting) dialog.current?.close()
      }}
    >
      <h2
        id="delete-project-context-title"
        className="text-sm font-bold text-ink"
      >
        Delete Project Context
      </h2>
      <p
        id="delete-project-context-description"
        className="mt-2 text-xs leading-relaxed text-ink-muted"
      >
        Deleting “{name}” permanently removes its Source Documents, Annotations,
        Extraction Schema, Extractions, and Review Decisions. This cannot be
        undone.
      </p>
      {failure && (
        <p className="mt-2 text-[11px] leading-snug text-danger" role="alert">
          {failure}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button
          size="md"
          autoFocus
          onClick={() => dialog.current?.close()}
          disabled={deleting}
        >
          Cancel
        </Button>
        <Button
          size="md"
          variant="primary"
          disabled={deleting}
          onClick={async () => {
            setDeleting(true)
            setFailure(null)
            const rejected = await onConfirm()
            if (rejected) {
              setDeleting(false)
              setFailure(rejected.message)
            } else dialog.current?.close()
          }}
        >
          {deleting ? 'Deleting…' : 'Delete permanently'}
        </Button>
      </div>
    </dialog>
  )
}

const card =
  'flex flex-col gap-2 rounded-lg border border-line bg-surface p-3 text-left'

function PencilIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
      <path d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793 3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 20 20" fill="none">
      <path d="M3.5 5.5h13M8 2.5h4l1 3H7l1-3ZM5.5 5.5l.75 11h7.5l.75-11M8.25 8.5v5M11.75 8.5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Managing one Project Context: its name, its Source Documents, and adding
 * more. An ingesting file renders as the same card it will become, so the grid
 * never shows more entries than there are Source Documents-to-be.
 */
export default function ProjectContextPage({
  projectContextId,
  onNavigate,
}: ProjectContextPageProps) {
  const {
    projects,
    branches,
    loadBranch,
    renameProject,
    deleteProject,
    ingestingSources,
    addSources,
    retrySource,
  } = useProjectContexts()
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const renameTrigger = useRef<HTMLButtonElement>(null)
  const deleteTrigger = useRef<HTMLButtonElement>(null)
  const restoreRenameFocus = useRef(false)
  const branch = branches[projectContextId]
  const project =
    branch?.status === 'ready'
      ? branch.detail.projectContext
      : projects.find(
          (candidate) => candidate.projectContextId === projectContextId,
        )
  const queued = ingestingSources.filter(
    (source) => source.projectContextId === projectContextId,
  )

  const addFiles = (files: readonly File[]) => {
    if (!files.length) return
    addSources(files.map((file) => ({ projectContextId, file })))
  }

  if (branch?.status === 'error')
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="flex flex-col items-center gap-4">
          <EmptyState
            className="max-w-sm bg-surface"
            icon="▢"
            title={
              branch.failure.code === 'not_found'
                ? 'That Project Context no longer exists'
                : 'Could not load this Project Context'
            }
            description={branch.failure.message}
            tone="danger"
          />
          <Button
            variant="secondary"
            size="md"
            onClick={() => loadBranch(projectContextId, true)}
          >
            Try again
          </Button>
        </div>
      </div>
    )

  return (
    <div className="scrollbar-subtle h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
        <header>
          {renaming && project ? (
            <RenameForm
              initialName={project.name}
              onSubmit={async (name) => {
                const rejected = await renameProject(projectContextId, name)
                if (!rejected) {
                  restoreRenameFocus.current = true
                  setRenaming(false)
                }
                return rejected
              }}
              onCancel={() => {
                restoreRenameFocus.current = true
                setRenaming(false)
              }}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-bold text-ink">
                {project?.name ?? 'Project Context'}
              </h1>
              <button
                ref={(button) => {
                  if (button && restoreRenameFocus.current) {
                    restoreRenameFocus.current = false
                    button.focus()
                  }
                  renameTrigger.current = button
                }}
                className="rounded-md p-1.5 text-ink-muted outline-none transition-colors hover:bg-accent-soft hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
                type="button"
                aria-label="Rename"
                title="Rename"
                onClick={() => setRenaming(true)}
                disabled={!project}
              >
                <PencilIcon />
              </button>
              <span className="flex-1" />
              <button
                ref={deleteTrigger}
                className="rounded-md p-1.5 text-danger outline-none transition-colors hover:bg-danger/10 focus-visible:ring-2 focus-visible:ring-danger/30 disabled:opacity-60"
                type="button"
                aria-label="Delete"
                title="Delete"
                onClick={() => setDeleting(true)}
                disabled={!project}
              >
                <TrashIcon />
              </button>
            </div>
          )}
        </header>

        <label
          className={`flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed px-6 py-8 text-center transition-colors ${
            dragging
              ? 'border-accent bg-accent-soft'
              : 'border-line-strong hover:border-accent'
          }`}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            // Unfiltered on purpose: the server owns PDF validation, so a
            // wrong file answers with a failed card and a reason instead of
            // being silently ignored.
            addFiles(Array.from(event.dataTransfer.files))
          }}
        >
          <span className="text-sm font-semibold text-ink">
            Drop PDFs here or browse
          </span>
          <input
            className="sr-only"
            type="file"
            accept=".pdf,application/pdf"
            aria-label="Add sources"
            multiple
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ''
              addFiles(files)
            }}
          />
        </label>

        {branch?.status === 'loading' && (
          <p className="text-xs text-ink-muted" aria-busy="true">
            Loading Source Documents…
          </p>
        )}

        {(queued.length > 0 || branch?.status === 'ready') && (
          <ul className="flex flex-col gap-3">
            {/* In-flight first: new work stays visible without scrolling. */}
            {queued.map((source) => (
              <li
                className={`${card} ${
                  source.status === 'failed' ? 'border-danger' : ''
                }`}
                key={source.ingestionKey}
                aria-live="polite"
              >
                <span className="truncate text-xs font-medium text-ink-muted">
                  {source.file.name}
                </span>
                {source.status === 'failed' ? (
                  <div className="flex items-end gap-3">
                    <span className="min-w-0 flex-1 text-[11px] leading-snug text-danger">
                      {source.failure}
                    </span>
                    <Button
                      onClick={() => retrySource(source.ingestionKey)}
                      aria-label={`Retry ${source.file.name}`}
                    >
                      Retry
                    </Button>
                  </div>
                ) : (
                  <>
                    <span className="text-[11px] text-ink-faint">
                      {source.status === 'parsing' ? 'Parsing…' : 'Queued'}
                    </span>
                    <span
                      className="h-0.5 overflow-hidden rounded-full bg-line"
                      aria-hidden="true"
                    >
                      <span
                        className={`block h-full bg-accent ${
                          source.status === 'parsing'
                            ? 'w-1/2 animate-pulse'
                            : 'w-0'
                        }`}
                      />
                    </span>
                  </>
                )}
              </li>
            ))}
            {branch?.status === 'ready' &&
              branch.detail.sourceDocuments.map((document) => (
                <li key={document.sourceDocumentId}>
                  <button
                    className={`${card} w-full cursor-pointer outline-none transition-colors hover:border-accent focus-visible:ring-1 focus-visible:ring-accent`}
                    type="button"
                    onClick={() =>
                      onNavigate({
                        kind: 'document',
                        projectContextId,
                        sourceDocumentId: document.sourceDocumentId,
                      })
                    }
                  >
                    <span className="truncate text-xs font-bold text-ink">
                      {document.name}
                    </span>
                    <span className="text-[11px] text-ink-faint">
                      {document.pageCount !== null && (
                        <>
                          {document.pageCount}{' '}
                          {document.pageCount === 1 ? 'page' : 'pages'} ·{' '}
                        </>
                      )}
                      Added{' '}
                      {new Date(document.createdAt).toLocaleDateString(undefined, {
                        dateStyle: 'medium',
                      })}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        )}

      </div>

      {deleting && project && (
        <DeleteDialog
          name={project.name}
          onConfirm={async () => {
            const rejected = await deleteProject(projectContextId)
            // The page's own Project Context is gone; nothing here can survive
            // it, so focus moves to the always-mounted rail toggle instead of
            // dropping onto <body>.
            if (!rejected) {
              onNavigate({ kind: 'root' })
              document
                .querySelector<HTMLElement>('[data-rail-toggle]')
                ?.focus()
            }
            return rejected
          }}
          onCancel={() => {
            setDeleting(false)
            deleteTrigger.current?.focus()
          }}
        />
      )}
    </div>
  )
}
