import { useEffect, useRef, useState } from 'react'
import type { NavigableRoute } from '../projectNavigation'
import { projectContextNameSchema } from '../../shared/projectContext.contract'
import { Button, EmptyState, Overline } from '../ui'
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
      className="flex flex-col gap-2"
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
        className="w-full max-w-md rounded-sm border border-line bg-canvas px-2 py-1.5 text-lg font-bold text-ink outline-none focus-visible:border-accent disabled:opacity-60"
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
          className="text-[11px] leading-snug text-danger"
          role="alert"
        >
          {failure}
        </p>
      )}
      <div className="flex gap-1.5">
        <Button
          type="submit"
          variant="primary"
          disabled={saving || !named.success}
        >
          Rename
        </Button>
        <Button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
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
        <header className="flex flex-col gap-3">
          <Overline as="p">Project Context</Overline>
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
            <div className="flex flex-wrap items-baseline gap-3">
              <h1 className="text-lg font-bold text-ink">
                {project?.name ?? 'Project Context'}
              </h1>
              <span className="flex-1" />
              <Button
                ref={(button) => {
                  if (button && restoreRenameFocus.current) {
                    restoreRenameFocus.current = false
                    button.focus()
                  }
                  renameTrigger.current = button
                }}
                onClick={() => setRenaming(true)}
                disabled={!project}
              >
                Rename
              </Button>
              <Button
                ref={deleteTrigger}
                onClick={() => setDeleting(true)}
                disabled={!project}
              >
                Delete
              </Button>
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
          <span className="text-[11px] text-ink-muted">
            Each PDF becomes a Source Document in this Project Context.
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
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
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
                  <>
                    <span className="text-[11px] leading-snug text-danger">
                      {source.failure}
                    </span>
                    <Button
                      onClick={() => retrySource(source.ingestionKey)}
                      aria-label={`Retry ${source.file.name}`}
                    >
                      Retry
                    </Button>
                  </>
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
                      Source Document
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        )}

        {branch?.status === 'ready' &&
          branch.detail.sourceDocuments.length === 0 &&
          queued.length === 0 && (
            <p className="text-xs leading-relaxed text-ink-muted">
              Empty Project Context. Add a PDF to start annotating it.
            </p>
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
