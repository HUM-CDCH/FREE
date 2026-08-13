import { useEffect, useRef, useState } from 'react'
import { useMachine } from '@xstate/react'
import GearIcon from '../GearIcon'
import PanelToggleIcon from '../PanelToggleIcon'
import { parseRoute, type NavigableRoute } from '../projectNavigation'
import { projectContextNameSchema } from '../../shared/projectContext.contract'
import { Button, Overline } from '../ui'
import { sourceIngestionMachine } from '../sourceIngestionMachine'
import { CreateProjectModal } from './CreateProjectModal'
import { ingestSourceDocument, toProjectContextFailure } from './transport'
import { useProjectContexts, type WriteResult } from './useProjectContexts'

export type ProjectContextRailProps = {
  open: boolean
  /** What the rail highlights; the shell computes it from route and overrides. */
  selection: NavigableRoute | null
  /** The routed Project Context; it stays expanded and loses its route on delete. */
  routedProjectContextId: string | null
  onToggle: () => void
  onNavigate: (route: NavigableRoute) => void
  onConfigure: () => void
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
        className="min-w-0 rounded-sm border border-line bg-canvas px-1.5 py-1 text-xs text-ink outline-none focus-visible:border-accent disabled:opacity-60"
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

export function ProjectContextRail({
  open,
  selection,
  routedProjectContextId,
  onToggle,
  onNavigate,
  onConfigure,
}: ProjectContextRailProps) {
  const {
    projects,
    listState,
    branches,
    loadBranch,
    retryList,
    createProject,
    renameProject,
    deleteProject,
    acknowledgeSourceDocument,
  } = useProjectContexts()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [collapsedRouted, setCollapsedRouted] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(
    null,
  )
  const restoreRenameFocus = useRef<string | null>(null)
  const restoreCreateFocus = useRef(false)
  const restoreDeleteFocus = useRef(false)
  const createTrigger = useRef<HTMLButtonElement>(null)
  const railToggle = useRef<HTMLButtonElement>(null)
  const completedSelections = useRef(new Set<string>())
  const [ingestion, sendIngestion] = useMachine(sourceIngestionMachine, {
    input: {
      ingest: (source) =>
        // The server owns ingestion once POSTed; actor shutdown only ignores its result.
        ingestSourceDocument(
          source.projectContextId,
          source.file,
          source.ingestionKey,
        ),
      toFailureMessage: (error) => toProjectContextFailure(error).message,
      onIngested: ({ item, result }) => {
        // The acknowledged response is the authority. Merging it into the rail
        // cache is a view update that may not apply yet; the conditional open
        // below never waits on it.
        acknowledgeSourceDocument(item.projectContextId, result)
        if (completedSelections.current.has(item.selectionKey)) return
        completedSelections.current.add(item.selectionKey)
        // Read live, not from a captured route: a researcher who navigated away
        // while this was in flight keeps the route they chose.
        const route = parseRoute(location.pathname)
        if (
          route.kind === 'project' &&
          route.projectContextId === item.projectContextId
        )
          onNavigate({
            kind: 'document',
            projectContextId: item.projectContextId,
            sourceDocumentId: result.sourceDocumentId,
          })
      },
    },
  })
  const queuedSources = ingestion.context.items
  useEffect(() => {
    const retainedSelections = new Set(
      queuedSources.map((source) => source.selectionKey),
    )
    for (const selectionKey of completedSelections.current)
      if (!retainedSelections.has(selectionKey))
        completedSelections.current.delete(selectionKey)
  }, [queuedSources])

  const activeProjectContextId =
    selection?.kind === 'project' || selection?.kind === 'document'
      ? selection.projectContextId
      : null
  const activeSourceDocumentId =
    selection?.kind === 'document' ? selection.sourceDocumentId : null
  const visibleExpanded =
    routedProjectContextId && !collapsedRouted.has(routedProjectContextId)
      ? new Set(expanded).add(routedProjectContextId)
      : expanded

  const toggle = (projectContextId: string) => {
    const isExpanded = visibleExpanded.has(projectContextId)
    setExpanded((current) => {
      const next = new Set(current)
      if (isExpanded) next.delete(projectContextId)
      else next.add(projectContextId)
      return next
    })
    setCollapsedRouted((current) => {
      const next = new Set(current)
      if (isExpanded && projectContextId === routedProjectContextId)
        next.add(projectContextId)
      else next.delete(projectContextId)
      return next
    })
    if (!isExpanded) loadBranch(projectContextId)
  }

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
          {projects.map((project) => (
            <li
              key={project.projectContextId}
              className={`h-4 w-px ${
                project.projectContextId === activeProjectContextId
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
        {listState.status === 'loading' && (
          <p className="py-6 pr-2 text-xs text-ink-muted" aria-live="polite">
            Loading Project Contexts…
          </p>
        )}
        {listState.status === 'error' && (
          <p className="py-6 pr-2 text-xs leading-relaxed text-danger">
            {listState.failure.message}{' '}
            <button
              className="font-semibold underline"
              type="button"
              onClick={retryList}
            >
              Retry
            </button>
          </p>
        )}
        {listState.status === 'ready' && projects.length === 0 && (
          <p className="py-6 pr-2 text-xs leading-relaxed text-ink-muted">
            No Project Contexts yet.
          </p>
        )}
        <ul className="flex flex-col">
          {projects.map((project) => {
            const projectContextId = project.projectContextId
            const isExpanded = visibleExpanded.has(projectContextId)
            const active = projectContextId === activeProjectContextId
            const branch = branches[projectContextId]
            return (
              <li key={projectContextId} className="py-0.5">
                {renaming === projectContextId ? (
                  <RenameForm
                    initialName={project.name}
                    onSubmit={async (name) => {
                      const rejected = await renameProject(
                        projectContextId,
                        name,
                      )
                      if (!rejected) {
                        restoreRenameFocus.current = projectContextId
                        setRenaming(null)
                      }
                      return rejected
                    }}
                    onCancel={() => {
                      restoreRenameFocus.current = projectContextId
                      setRenaming(null)
                    }}
                  />
                ) : (
                  <div className="group flex items-center">
                    <button
                      className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-1.5 rounded-sm py-1 pr-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent"
                      type="button"
                      aria-expanded={isExpanded}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => {
                        toggle(projectContextId)
                        if (!active)
                          onNavigate({ kind: 'project', projectContextId })
                      }}
                    >
                      <span
                        aria-hidden="true"
                        className={active ? 'text-accent' : 'text-ink-faint'}
                      >
                        {isExpanded ? '▾' : '▸'}
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
                          restoreRenameFocus.current === projectContextId
                        ) {
                          restoreRenameFocus.current = null
                          button.focus()
                        }
                      }}
                      className={rowAction}
                      type="button"
                      aria-label={`Rename ${project.name}`}
                      onClick={() => setRenaming(projectContextId)}
                    >
                      Rename
                    </button>
                    <button
                      className={`${rowAction} mr-1 hover:text-danger`}
                      type="button"
                      aria-label={`Delete ${project.name}`}
                      onClick={() =>
                        setDeleting({
                          id: projectContextId,
                          name: project.name,
                        })
                      }
                    >
                      Delete
                    </button>
                  </div>
                )}

                {isExpanded && (
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
                          onClick={() => loadBranch(projectContextId, true)}
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
                          document.sourceDocumentId === activeSourceDocumentId
                        return (
                          <div
                            className={`group flex items-center border-l pl-3 ${
                              documentActive ? 'border-accent' : 'border-line'
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
                                  projectContextId,
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
                        {queuedSources
                          .filter(
                            (source) =>
                              source.projectContextId === projectContextId,
                          )
                          .map((source) => (
                            <p
                              className={`py-1 text-[11px] leading-snug ${guide} ${
                                source.status === 'failed'
                                  ? 'text-danger'
                                  : source.status === 'saved'
                                    ? 'text-ink-muted'
                                    : 'text-ink-faint'
                              }`}
                              key={source.ingestionKey}
                              aria-live="polite"
                            >
                              {source.file.name}:{' '}
                              {source.status === 'parsing'
                                ? 'Parsing…'
                                : source.status === 'saved'
                                  ? 'Saved'
                                  : source.status === 'failed'
                                    ? `Failed: ${source.failure}`
                                    : 'Queued'}
                              {source.status === 'failed' && (
                                <button
                                  className="ml-1 font-semibold underline"
                                  type="button"
                                  onClick={() =>
                                    sendIngestion({
                                      type: 'source.retry',
                                      ingestionKey: source.ingestionKey,
                                    })
                                  }
                                >
                                  Retry
                                </button>
                              )}
                            </p>
                          ))}
                        <label
                          className={`block cursor-pointer py-1.5 text-[11px] font-semibold text-ink-muted hover:text-accent ${guide}`}
                        >
                          + Add sources
                          <input
                            className="sr-only"
                            type="file"
                            accept=".pdf,application/pdf"
                            aria-label="Add sources"
                            multiple
                            onChange={(event) => {
                              const files = Array.from(event.target.files ?? [])
                              event.target.value = ''
                              if (!files.length) return
                              // One selection, one canonical ingestion key per
                              // file; only the first success auto-opens.
                              const selectionKey = crypto.randomUUID()
                              const sources = files.map((file, index) => ({
                                projectContextId,
                                file,
                                ingestionKey:
                                  index === 0
                                    ? selectionKey
                                    : crypto.randomUUID(),
                                selectionKey,
                              }))
                              sendIngestion({
                                type: 'sources.added',
                                items: sources,
                              })
                            }}
                          />
                        </label>
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
        <div className="flex items-center gap-2">
          <button
            ref={createTrigger}
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
      </footer>

      {creating && (
        <CreateProjectModal
          onSubmit={async (name) => {
            const result = await createProject(name)
            if (result.created) {
              restoreCreateFocus.current = true
              // Routing to the created Project Context expands it and reads
              // its (empty) branch.
              onNavigate({
                kind: 'project',
                projectContextId: result.created.projectContextId,
              })
            }
            return result.failure ?? null
          }}
          onClose={() => {
            setCreating(false)
            if (restoreCreateFocus.current) {
              restoreCreateFocus.current = false
              createTrigger.current?.focus()
            }
          }}
        />
      )}
      {deleting && (
        <DeleteDialog
          name={deleting.name}
          onConfirm={async () => {
            const rejected = await deleteProject(deleting.id)
            if (!rejected) {
              // Drops local ownership only; an already-POSTed ingestion still
              // finishes on the server and its late result is ignored.
              sendIngestion({
                type: 'project.deleted',
                projectContextId: deleting.id,
              })
              restoreDeleteFocus.current = true
              // Only the routed Project Context loses its route; any other
              // one keeps it.
              if (deleting.id === routedProjectContextId)
                onNavigate({ kind: 'root' })
            }
            return rejected
          }}
          onCancel={() => {
            setDeleting(null)
            if (restoreDeleteFocus.current) {
              restoreDeleteFocus.current = false
              // The row is gone; the stable rail toggle takes focus instead.
              railToggle.current?.focus()
            }
          }}
        />
      )}
    </div>
  )
}
