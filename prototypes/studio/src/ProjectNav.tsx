import GearIcon from './GearIcon'
import PanelToggleIcon from './PanelToggleIcon'
import type { NavigableRoute } from './projectNavigation'
import { Overline } from './ui'
import type { RailTree } from './useRailTree'

type ProjectNavProps = {
  tree: RailTree
  open: boolean
  onToggle: () => void
  onNavigate: (route: NavigableRoute) => void
  onConfigure: () => void
  onOpenDevDocument: (sourceDocument: File) => void
}

const guide = 'border-l border-line pl-3'

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

function ProjectNav({
  tree,
  open,
  onToggle,
  onNavigate,
  onConfigure,
  onOpenDevDocument,
}: ProjectNavProps) {
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
                  <RowMenu />
                </div>

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

      <footer className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2.5">
        <button
          className="flex cursor-default items-center gap-1.5 text-[11px] font-semibold text-ink-faint opacity-60"
          type="button"
          disabled
          title="Not available yet"
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
      </footer>
    </div>
  )
}

export default ProjectNav
