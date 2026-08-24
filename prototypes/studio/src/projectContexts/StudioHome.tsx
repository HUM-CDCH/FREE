import { useState } from 'react'
import type { NavigableRoute } from '../projectNavigation'
import { Button, EmptyState } from '../ui'
import PlusIcon from '../PlusIcon'
import { CreateProjectModal } from './CreateProjectModal'
import { useProjectContexts } from './useProjectContexts'

/**
 * The landing page for an unrouted Studio: every Project Context as a card on
 * the paper canvas. Opening one routes to its Sources tab, the same route the
 * rail uses.
 */
export function StudioHome({
  onNavigate,
}: {
  onNavigate: (route: NavigableRoute) => void
}) {
  const { projects, listState, retryList, createProject } = useProjectContexts()
  const [creating, setCreating] = useState(false)

  const open = (projectContextId: string) =>
    onNavigate({ kind: 'project', projectContextId, tab: 'sources' })

  return (
    <div className="scrollbar-subtle h-full overflow-y-auto p-12">
      <div className="mb-10 flex items-end justify-between">
        <h1 className="font-serif text-[32px] leading-none font-normal tracking-[-0.01em] text-ink">
          Projects
        </h1>
        <Button variant="primary" size="md" onClick={() => setCreating(true)}>
          <PlusIcon />
          New Project
        </Button>
      </div>

      {listState.status === 'error' ? (
        <EmptyState
          className="max-w-sm bg-surface"
          title="Could not load your Project Contexts"
          description={listState.failure.message}
          tone="danger"
        >
          <Button variant="secondary" size="md" onClick={retryList}>
            Try again
          </Button>
        </EmptyState>
      ) : projects.length === 0 ? (
        listState.status === 'loading' ? (
          <p className="text-sm text-ink-muted" aria-busy="true">
            Loading Project Contexts…
          </p>
        ) : (
          <EmptyState
            className="max-w-sm bg-surface"
            title="No Project Contexts yet"
            description="Create one to start ingesting Source Documents."
          />
        )
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-7">
          {projects.map((project) => (
            <li key={project.projectContextId}>
              <button
                type="button"
                aria-labelledby={`project-${project.projectContextId}-name`}
                aria-describedby={`project-${project.projectContextId}-count`}
                className="flex w-full cursor-pointer flex-col items-start gap-1 rounded-[3px] bg-surface px-8 py-8 text-left outline-none transition-shadow hover:shadow-float focus-visible:ring-2 focus-visible:ring-accent/40"
                onClick={() => open(project.projectContextId)}
              >
                <h2
                  id={`project-${project.projectContextId}-name`}
                  className="font-serif text-[18px] font-normal text-ink"
                >
                  {project.name}
                </h2>
                <span
                  id={`project-${project.projectContextId}-count`}
                  className="text-xs text-ink-faint"
                >
                  {project.sourceDocumentCount}{' '}
                  {project.sourceDocumentCount === 1
                    ? 'Source Document'
                    : 'Source Documents'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <CreateProjectModal
          onSubmit={async (name) => {
            const result = await createProject(name)
            // Routing to the created Project Context opens its page; a new one
            // has no schemas and no Batch Extractions, so Sources is the only
            // thing to do with it.
            if (result.created) open(result.created.projectContextId)
            return result.failure ?? null
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  )
}
