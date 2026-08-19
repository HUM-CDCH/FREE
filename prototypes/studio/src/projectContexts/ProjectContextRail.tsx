import { useEffect, useRef, useState } from 'react'
import GearIcon from '../GearIcon'
import PanelToggleIcon from '../PanelToggleIcon'
import type { NavigableRoute } from '../projectNavigation'
import { DeleteDialog, Overline } from '../ui'
import { CreateProjectModal } from './CreateProjectModal'
import { useProjectContexts } from './useProjectContexts'

function TrashIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 20 20" fill="none">
      <path
        d="M3.5 5.5h13M8 2.5h4l1 3H7l1-3ZM5.5 5.5l.75 11h7.5l.75-11M8.25 8.5v5M11.75 8.5v5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export type ProjectContextRailProps = {
  open: boolean
  /** What the rail highlights; the shell computes it from route and overrides. */
  selection: NavigableRoute | null
  /** The routed Project Context; it stays expanded and loses its route on delete. */
  routedProjectContextId: string | null
  onToggle: () => void
  onNavigate: (route: NavigableRoute) => void
  /** Clicking a Source Document row opens it as a tab. */
  onOpenSourceDocument: (
    projectContextId: string,
    sourceDocumentId: string,
    name: string,
  ) => void
  onConfigure: () => void
}

const guide = 'border-l border-line pl-3'

function PlusIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 20 20" fill="none">
      <path
        d="M10 3.5v13M3.5 10h13"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

function AddSourceDocumentsControl({
  projectContextId,
  projectName,
  addSources,
}: {
  projectContextId: string
  projectName: string
  addSources: (sources: readonly { projectContextId: string; file: File }[]) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <>
      {/* A separate trigger, not a label: the OS file picker focuses and
          blurs the input on its own schedule, which flashes any style tied
          to the input's own focus. The button's focus never moves. */}
      <button
        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-ink-faint outline-none transition-colors hover:bg-accent-ghost hover:text-accent focus-visible:bg-accent-ghost focus-visible:text-accent focus-visible:ring-1 focus-visible:ring-accent"
        type="button"
        aria-label={`Add Source Documents to ${projectName}`}
        title="Add Source Documents"
        onClick={() => inputRef.current?.click()}
      >
        <PlusIcon />
      </button>
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        tabIndex={-1}
        accept=".pdf,application/pdf"
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (files.length)
            addSources(files.map((file) => ({ projectContextId, file })))
        }}
      />
    </>
  )
}

/**
 * Renaming and deleting live on the Project Context page, so the rail's list
 * is exactly the persisted research state and never grows entries that are
 * not Source Documents. The row's name and chevron both only expand or
 * collapse its Source Documents; opening the Project Context page and adding
 * a Source Document to it are actions in the row's own menu.
 */
export function ProjectContextRail({
  open,
  selection,
  routedProjectContextId,
  onToggle,
  onNavigate,
  onOpenSourceDocument,
  onConfigure,
}: ProjectContextRailProps) {
  const {
    projects,
    listState,
    branches,
    loadBranch,
    retryList,
    createProject,
    addSources,
    deleteSourceDocument,
  } = useProjectContexts()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [collapsedRouted, setCollapsedRouted] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const [creating, setCreating] = useState(false)
  const restoreCreateFocus = useRef(false)
  const createTrigger = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // Right-click on a Source Document row opens this instead of a visible
  // "•••" button — deleting stays a deliberate, out-of-the-way action here,
  // unlike the Project Context page's own always-visible menu.
  const [sourceContextMenu, setSourceContextMenu] = useState<{
    projectContextId: string
    sourceDocumentId: string
    name: string
    x: number
    y: number
  } | null>(null)
  const [deletingSource, setDeletingSource] = useState<{
    projectContextId: string
    sourceDocumentId: string
    name: string
  } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  // Only one row menu stays open at a time; a pointerdown outside every open
  // <details> closes it, matching the Project Context page's source menus.
  useEffect(() => {
    const closeOtherMenus = (event: PointerEvent) => {
      const openMenus = listRef.current?.querySelectorAll('details[open]')
      openMenus?.forEach((details) => {
        if (!details.contains(event.target as Node)) {
          details.removeAttribute('open')
        }
      })
    }
    document.addEventListener('pointerdown', closeOtherMenus)
    return () => document.removeEventListener('pointerdown', closeOtherMenus)
  }, [])

  // The right-click context menu closes the same way: any outside pointerdown
  // or an Escape key dismisses it. A pointerdown inside it (e.g. on "Delete")
  // is left alone so that click still lands before the menu unmounts.
  useEffect(() => {
    if (!sourceContextMenu) return
    const closeMenu = (event: PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node))
        setSourceContextMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSourceContextMenu(null)
    }
    document.addEventListener('pointerdown', closeMenu)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', closeMenu)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [sourceContextMenu])

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

  // Navigating to a Project Context expands it for good, so its Source
  // Documents stay listed once the route moves on to another one.
  const navigate = (projectContextId: string) => {
    setExpanded((current) => new Set(current).add(projectContextId))
    setCollapsedRouted((current) => {
      if (!current.has(projectContextId)) return current
      const next = new Set(current)
      next.delete(projectContextId)
      return next
    })
    onNavigate({ kind: 'project', projectContextId })
  }

  if (!open)
    return (
      <div className="flex h-full flex-col items-center py-3">
        <button
          data-rail-toggle
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
        <Overline as="h2">Project</Overline>
        <button
          data-rail-toggle
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
        <ul className="flex flex-col" ref={listRef}>
          {projects.map((project) => {
            const projectContextId = project.projectContextId
            const isExpanded = visibleExpanded.has(projectContextId)
            const active = projectContextId === activeProjectContextId
            const branch = branches[projectContextId]
            return (
              <li key={projectContextId} className="py-0.5">
                {/* The chevron and the name are one control: either discloses
                    Source Documents. Opening the Project Context page and
                    adding to it live in the row's own menu. */}
                <div className="flex items-center gap-0.5">
                  <button
                    data-project-row
                    className={`flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-sm py-1 pl-1 pr-1 text-left outline-none transition-colors hover:bg-accent-ghost focus-visible:bg-accent-ghost focus-visible:ring-1 focus-visible:ring-accent ${
                      active ? 'text-accent' : 'text-ink-faint hover:text-accent'
                    }`}
                    type="button"
                    aria-expanded={isExpanded}
                    aria-current={active ? 'page' : undefined}
                    aria-label={`${
                      isExpanded ? 'Collapse' : 'Expand'
                    } Source Documents in ${project.name}`}
                    onClick={() => toggle(projectContextId)}
                  >
                    <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
                    <span
                      className={`min-w-0 flex-1 truncate text-[11px] font-bold uppercase tracking-[0.07em] ${
                        active ? 'text-accent' : 'text-ink-muted'
                      }`}
                    >
                      {project.name}
                    </span>
                  </button>
                  <AddSourceDocumentsControl
                    projectContextId={projectContextId}
                    projectName={project.name}
                    addSources={addSources}
                  />
                  <details className="relative shrink-0">
                    <summary
                      className="flex size-6 cursor-pointer list-none items-center justify-center rounded-sm text-ink-faint outline-none transition-colors hover:bg-accent-ghost hover:text-accent focus-visible:ring-1 focus-visible:ring-accent [&::-webkit-details-marker]:hidden"
                      role="button"
                      aria-label={`Actions for ${project.name}`}
                    >
                      <span aria-hidden="true">•••</span>
                    </summary>
                    <div className="absolute right-0 top-7 z-10 w-40 rounded-2xl bg-ink p-1.5 text-xs text-white shadow-md">
                      <button
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"
                        type="button"
                        onClick={(event) => {
                          event.currentTarget
                            .closest('details')
                            ?.removeAttribute('open')
                          // Reopening the routed Project Context page would
                          // push a duplicate history entry.
                          if (
                            selection?.kind === 'project' &&
                            selection.projectContextId === projectContextId
                          )
                            return
                          navigate(projectContextId)
                        }}
                      >
                        Open project
                      </button>
                    </div>
                  </details>
                </div>

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
                            className={`flex items-center border-l pl-3 ${
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
                              onClick={() =>
                                onOpenSourceDocument(
                                  projectContextId,
                                  document.sourceDocumentId,
                                  document.name,
                                )
                              }
                              onContextMenu={(event) => {
                                event.preventDefault()
                                setSourceContextMenu({
                                  projectContextId,
                                  sourceDocumentId: document.sourceDocumentId,
                                  name: document.name,
                                  x: event.clientX,
                                  y: event.clientY,
                                })
                              }}
                            >
                              {document.name}
                            </button>
                          </div>
                        )
                      })}
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

      {sourceContextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-20 w-40 rounded-2xl border border-line bg-surface p-1.5 text-xs shadow-lg"
          style={{ left: sourceContextMenu.x, top: sourceContextMenu.y }}
        >
          <button
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-danger hover:bg-danger-soft focus-visible:bg-danger-soft focus-visible:outline-none"
            type="button"
            onClick={() => {
              setDeletingSource({
                projectContextId: sourceContextMenu.projectContextId,
                sourceDocumentId: sourceContextMenu.sourceDocumentId,
                name: sourceContextMenu.name,
              })
              setSourceContextMenu(null)
            }}
          >
            <TrashIcon />
            Delete
          </button>
        </div>
      )}

      {deletingSource && (
        <DeleteDialog
          title="Delete Source Document"
          description={
            <>
              Deleting “{deletingSource.name}” permanently removes its
              annotations and extractions. This cannot be undone.
            </>
          }
          onConfirm={() =>
            deleteSourceDocument(
              deletingSource.projectContextId,
              deletingSource.sourceDocumentId,
            )
          }
          onCancel={() => setDeletingSource(null)}
        />
      )}

      {creating && (
        <CreateProjectModal
          onSubmit={async (name) => {
            const result = await createProject(name)
            if (result.created) {
              restoreCreateFocus.current = true
              // Routing to the created Project Context opens its page and
              // reads its (empty) branch.
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
    </div>
  )
}
