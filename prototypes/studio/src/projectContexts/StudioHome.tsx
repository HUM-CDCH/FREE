import { useState } from 'react'
import type { NavigableRoute } from '../projectNavigation'
import { Button, EmptyState } from '../ui'
import PlusIcon from '../PlusIcon'
import { CreateProjectModal } from './CreateProjectModal'
import { useProjectContexts } from './useProjectContexts'

const phases = [
  { number: '01', name: 'Ingest', copy: 'Add your Source Documents.' },
  {
    number: '02',
    name: 'Chat',
    copy: 'Describe what you want to extract; a schema is drafted.',
  },
  { number: '03', name: 'Approve', copy: 'Refine the schema, then approve it.' },
  {
    number: '04',
    name: 'Extract',
    copy: 'Run it across your documents, one or in batch.',
  },
  { number: '05', name: 'Validate', copy: 'Review each value against its Evidence.' },
]

/** The zero-Project-Context welcome: promise, workflow walkthrough, one action. */
function FirstRun({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-14 p-12">
      <div className="flex max-w-lg flex-col items-center gap-3.5 text-center">
        <h1 className="font-serif text-[38px] leading-[1.25] font-normal tracking-[-0.01em] text-ink">
          From source to structured data, with the evidence to prove it
        </h1>
        <p className="text-sm leading-relaxed text-ink-muted">
          Describe what you need in a conversation, approve the schema it
          drafts, and review every extracted value against its source.
        </p>
      </div>

      <ol className="flex flex-wrap items-start justify-center gap-x-16 gap-y-8">
        {phases.map((phase) => (
          <li key={phase.number} className="flex w-[150px] flex-col gap-1.5 pt-4">
            <span aria-hidden="true" className="font-mono text-[11px] text-accent">
              {phase.number}
            </span>
            <span className="text-[13px] font-semibold text-ink">
              {phase.name}
            </span>
            <span className="text-[11.5px] leading-relaxed text-ink-muted">
              {phase.copy}
            </span>
          </li>
        ))}
      </ol>

      <Button variant="primary" size="md" className="px-6 py-3" onClick={onCreate}>
        <PlusIcon />
        Create your first project
      </Button>
    </div>
  )
}

/**
 * The landing page for an unrouted Studio: every Project Context as a card on
 * the paper canvas, or the first-run walkthrough when none exist yet. Opening
 * one routes to its Sources tab, the same route the rail uses.
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

  const createModal = creating && (
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
  )

  if (listState.status === 'ready' && projects.length === 0)
    return (
      <>
        <FirstRun onCreate={() => setCreating(true)} />
        {createModal}
      </>
    )

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
        <p className="text-sm text-ink-muted" aria-busy="true">
          Loading Project Contexts…
        </p>
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

      {createModal}
    </div>
  )
}
