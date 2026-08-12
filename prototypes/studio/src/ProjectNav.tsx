import { useEffect, useRef, useState } from 'react'
import GearIcon from './GearIcon'
import PanelToggleIcon from './PanelToggleIcon'
import type { NavigableRoute } from './projectNavigation'
import { projectContextNameSchema } from '../shared/projectContext.contract'
import { Button, Overline } from './ui'
import type { RailTree, RailWriteResult } from './useRailTree'

type ProjectNavProps = {
  tree: RailTree
  open: boolean
  onToggle: () => void
  onNavigate: (route: NavigableRoute) => void
  onConfigure: () => void
  onOpenDevDocument: (sourceDocument: File) => void
}

const guide = 'border-l border-line pl-3'
const rowAction =
  'shrink-0 cursor-pointer rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-faint opacity-0 outline-none transition-opacity hover:text-accent focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-accent group-hover:opacity-70 group-focus-within:opacity-70'

function RowMenu() {
  return (
    <button
      className="mr-1 shrink-0 cursor-default rounded p-0.5 text-ink-faint opacity-0 transition-opacity group-hover:opacity-55 group-focus-within:opacity-55"
      type="button"
      disabled
      title="Not available yet"
      aria-label="Row actions"
    >
      ⋮
    </button>
  )
}

/**
 * The one name form behind create and rename. It keeps the typed name and shows
 * a retryable failure in place; only an acknowledged write closes it.
 */
function NameForm({
  label,
  submitLabel,
  initialName = '',
  onSubmit,
  onCancel,
}: {
  label: string
  submitLabel: string
  initialName?: string
  onSubmit: (name: string) => RailWriteResult
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
      className="flex flex-col gap-1 py-1"
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
        className="min-w-0 rounded-sm border border-line bg-canvas px-1.5 py-1 text-xs text-ink outline-none focus-visible:border-accent"
        aria-label={label}
        value={name}
        disabled={saving}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
        }}
      />
      {failure && (
        <p className="text-[11px] leading-snug text-danger" role="alert">
          {failure}
        </p>
      )}
      <div className="flex gap-1.5">
        <Button
          type="submit"
          variant="primary"
          disabled={saving || !named.success}
        >
          {submitLabel}
        </Button>
        <Button onClick={onCancel} disabled={saving}>
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
  onConfirm: () => RailWriteResult
  onCancel: () => void
}) {
  const [failure, setFailure] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)

  // Native modality owns focus: `showModal` moves focus in, contains Tab, and
  // restores it to the Delete row on close. Nothing hand-rolled matches it.
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  const close = () => dialog.current?.close()

  return (
    <dialog
      className="w-full max-w-sm rounded-lg border border-line bg-surface p-5 text-ink backdrop:bg-ink/55 backdrop:backdrop-blur-[2px]"
      ref={dialog}
      aria-labelledby="delete-project-context-title"
      aria-describedby="delete-project-context-description"
      onClose={onCancel}
      // Escape and every other dismissal wait for a write in flight, so a
      // failure keeps the dialog and its retry.
      onCancel={(event) => {
        event.preventDefault()
        if (!deleting) close()
      }}
    >
      <h2
        className="text-sm font-bold text-ink"
        id="delete-project-context-title"
      >
        Delete Project Context
      </h2>
      <p
        className="mt-2 text-xs leading-relaxed text-ink-muted"
        id="delete-project-context-description"
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
        <Button autoFocus size="md" onClick={close} disabled={deleting}>
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
            } else close()
          }}
        >
          Delete permanently
        </Button>
      </div>
    </dialog>
  )
}

function ProjectNav({
  tree,
  open,
  onToggle,
  onNavigate,
  onConfigure,
  onOpenDevDocument,
}: ProjectNavProps) {
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const restoreNameFocus = useRef<'create' | string | null>(null)
  const restoreDeleteFocus = useRef(false)
  const railToggle = useRef<HTMLButtonElement>(null)
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(
    null,
  )

  if (!open)
    return (
      <div className="flex h-full flex-col items-center py-3">
        <button
          className="cursor-pointer text-ink-muted outline-none transition-colors hover:text-accent focus-visible:text-accent"
          type="button"
          aria-label="Expand Project Contexts"
          title="Expand Project Contexts"
          onClick={onToggle}
        >
          <PanelToggleIcon side="left" />
        </button>
        <ul className="mt-3 flex flex-col gap-2" aria-hidden="true">
          {tree.projects.map((project) => (
            <li
              key={project.projectContextId}
              className={`h-4 w-px ${
                project.projectContextId === tree.activeProjectContextId
                  ? 'bg-accent'
                  : 'bg-line-strong'
              }`}
            />
          ))}
        </ul>
      </div>
    )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between py-3 pl-4 pr-2.5">
        <Overline as="h2">Project Contexts</Overline>
        <button
          ref={railToggle}
          className="cursor-pointer px-1 text-ink-muted outline-none transition-colors hover:text-accent focus-visible:text-accent"
          type="button"
          aria-label="Collapse Project Contexts"
          title="Collapse Project Contexts"
          onClick={onToggle}
        >
          <PanelToggleIcon side="left" />
        </button>
      </header>

      <nav
        className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto pb-3 pl-3 pr-2"
        aria-label="Project Contexts"
      >
        {tree.listState.status === 'loading' && (
          <p className="py-6 pr-2 text-xs text-ink-muted" aria-live="polite">
            Loading Project Contexts…
          </p>
        )}
        {tree.listState.status === 'error' && (
          <p className="py-6 pr-2 text-xs leading-relaxed text-danger">
            {tree.listState.failure.message}{' '}
            <button
              className="font-semibold underline"
              type="button"
              onClick={() => tree.retryList()}
            >
              Retry
            </button>
          </p>
        )}
        {tree.listState.status === 'ready' && tree.projects.length === 0 && (
          <p className="py-6 pr-2 text-xs leading-relaxed text-ink-muted">
            No Project Contexts yet.
          </p>
        )}
        <ul className="flex flex-col">
          {tree.projects.map((project) => {
            const expanded = tree.expanded.has(project.projectContextId)
            const active =
              project.projectContextId === tree.activeProjectContextId
            const branch = tree.branches[project.projectContextId]
            return (
              <li key={project.projectContextId} className="py-0.5">
                {renaming === project.projectContextId ? (
                  <NameForm
                    label="Project Context name"
                    submitLabel="Rename"
                    initialName={project.name}
                    onSubmit={async (name) => {
                      const rejected = await tree.renameProject(
                        project.projectContextId,
                        name,
                      )
                      if (!rejected) {
                        restoreNameFocus.current = project.projectContextId
                        setRenaming(null)
                      }
                      return rejected
                    }}
                    onCancel={() => {
                      restoreNameFocus.current = project.projectContextId
                      setRenaming(null)
                    }}
                  />
                ) : (
                <div className="group flex items-center">
                  <button
                    className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-1.5 rounded-sm py-1 pr-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    type="button"
                    aria-expanded={expanded}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      tree.toggle(project.projectContextId)
                      if (!active)
                        onNavigate({
                          kind: 'project',
                          projectContextId: project.projectContextId,
                        })
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className={active ? 'text-accent' : 'text-ink-faint'}
                    >
                      {expanded ? '▾' : '▸'}
                    </span>
                    <span
                      className={`min-w-0 truncate text-[11px] font-bold uppercase tracking-[0.07em] ${
                        active ? 'text-accent' : 'text-ink-muted'
                      }`}
                    >
                      {project.name}
                    </span>
                  </button>
                  <button
                    ref={(button) => {
                      if (
                        button &&
                        restoreNameFocus.current === project.projectContextId
                      ) {
                        restoreNameFocus.current = null
                        button.focus()
                      }
                    }}
                    className={rowAction}
                    type="button"
                    aria-label={`Rename ${project.name}`}
                    onClick={() => setRenaming(project.projectContextId)}
                  >
                    Rename
                  </button>
                  <button
                    className={`${rowAction} mr-1 hover:text-danger`}
                    type="button"
                    aria-label={`Delete ${project.name}`}
                    onClick={() =>
                      setDeleting({
                        id: project.projectContextId,
                        name: project.name,
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
                )}

                {expanded && (
                  <div className="ml-1.5">
                    {branch?.status === 'loading' && (
                      <p className={`py-1 text-[11px] text-ink-muted ${guide}`}>
                        Loading…
                      </p>
                    )}
                    {branch?.status === 'error' && (
                      <p
                        className={`py-1 pr-1 text-[11px] leading-snug text-danger ${guide}`}
                      >
                        Could not read Source Documents.{' '}
                        <button
                          className="font-semibold underline"
                          type="button"
                          onClick={() =>
                            tree.retryBranch(project.projectContextId)
                          }
                        >
                          Retry
                        </button>
                      </p>
                    )}
                    {branch?.status === 'ready' &&
                      branch.detail.sourceDocuments.length === 0 && (
                        <p
                          className={`py-1 pr-1 text-[11px] leading-snug text-ink-muted ${guide}`}
                        >
                          Empty Project Context.
                        </p>
                      )}
                    {branch?.status === 'ready' &&
                      branch.detail.sourceDocuments.map((document) => {
                        const documentActive =
                          document.sourceDocumentId ===
                          tree.activeSourceDocumentId
                        return (
                          <div
                            className={`group flex items-center border-l pl-3 ${
                              documentActive
                                ? 'border-accent'
                                : 'border-line'
                            }`}
                            key={document.sourceDocumentId}
                          >
                            <button
                              className={`min-w-0 flex-1 cursor-pointer truncate rounded-sm py-1.5 pr-1 text-left text-xs outline-none transition-colors focus-visible:ring-1 focus-visible:ring-accent ${
                                documentActive
                                  ? 'font-bold text-ink'
                                  : 'font-medium text-ink-muted hover:text-ink'
                              }`}
                              type="button"
                              aria-current={documentActive ? 'page' : undefined}
                              onClick={() => {
                                // Reopening the open Source Document would push a
                                // duplicate history entry and re-read it.
                                if (documentActive) return
                                onNavigate({
                                  kind: 'document',
                                  projectContextId: project.projectContextId,
                                  sourceDocumentId: document.sourceDocumentId,
                                })
                              }}
                            >
                              {document.name}
                            </button>
                            <RowMenu />
                          </div>
                        )
                      })}
                    {branch?.status === 'ready' && (
                      <>
                        <button
                          className={`flex cursor-default items-center gap-1.5 py-1.5 text-[11px] font-semibold text-ink-faint opacity-60 ${guide}`}
                          type="button"
                          disabled
                          title="Not available yet"
                        >
                          + Add sources
                        </button>
                        {import.meta.env.DEV && (
                          <label
                            className={`block cursor-pointer py-1 text-[11px] font-medium text-ink-muted hover:text-accent ${guide}`}
                          >
                            Open a PDF (dev)
                            <input
                              className="sr-only"
                              type="file"
                              accept=".pdf,application/pdf"
                              aria-label="Open a PDF (dev)"
                              onChange={(event) => {
                                const sourceDocument = event.target.files?.[0]
                                if (sourceDocument)
                                  onOpenDevDocument(sourceDocument)
                                event.target.value = ''
                              }}
                            />
                          </label>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </nav>

      <footer className="shrink-0 border-t border-line px-3 py-2.5">
        {creating ? (
          <NameForm
            label="New Project Context name"
            submitLabel="Create"
            onSubmit={async (name) => {
              const rejected = await tree.createProject(name)
              if (!rejected) {
                restoreNameFocus.current = 'create'
                setCreating(false)
              }
              return rejected
            }}
            onCancel={() => {
              restoreNameFocus.current = 'create'
              setCreating(false)
            }}
          />
        ) : (
          <div className="flex items-center gap-2">
            <button
              ref={(button) => {
                if (button && restoreNameFocus.current === 'create') {
                  restoreNameFocus.current = null
                  button.focus()
                }
              }}
              className="flex cursor-pointer items-center gap-1.5 rounded-sm text-[11px] font-semibold text-ink-muted outline-none hover:text-accent focus-visible:ring-1 focus-visible:ring-accent"
              type="button"
              onClick={() => setCreating(true)}
            >
              + New project
            </button>
            <span className="flex-1" />
            <button
              className="rounded p-1 text-ink-muted outline-none transition-colors hover:text-accent focus-visible:text-accent"
              type="button"
              aria-label="Configure providers"
              title="Configure providers"
              onClick={onConfigure}
            >
              <GearIcon />
            </button>
          </div>
        )}
      </footer>

      {deleting && (
        <DeleteDialog
          name={deleting.name}
          onConfirm={async () => {
            const rejected = await tree.deleteProject(deleting.id)
            if (!rejected) restoreDeleteFocus.current = true
            return rejected
          }}
          onCancel={() => {
            setDeleting(null)
            if (restoreDeleteFocus.current) {
              restoreDeleteFocus.current = false
              railToggle.current?.focus()
            }
          }}
        />
      )}
    </div>
  )
}

export default ProjectNav
