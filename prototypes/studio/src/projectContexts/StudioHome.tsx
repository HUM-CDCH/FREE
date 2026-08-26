import { useState } from 'react'
import type { NavigableRoute } from '../projectNavigation'
import type { ProjectContext } from './transport'
import { Button, EmptyState, Overline, PhaseProgress } from '../ui'
import type { PhaseProgressTone } from '../ui'
import type { ProjectContextActivityEvent } from './transport'
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

/**
 * The quiet one-line card meta from the persisted summary: the Source Document
 * count, then the most decision-relevant state — staleness first, then review
 * progress, then schema drafts still in chat.
 */
function metaLine(project: ProjectContext): string {
  const count = project.sourceDocumentCount
  const documents = `${count} ${count === 1 ? 'Source Document' : 'Source Documents'}`
  const summary = project.summary
  if (summary.staleSourceDocumentCount > 0)
    return `${documents} · ${summary.staleSourceDocumentCount} changed since extraction`
  if (summary.extractedSourceDocumentCount > 0)
    return `${documents} · ${summary.reviewedSourceDocumentCount} of ${summary.extractedSourceDocumentCount} reviewed`
  if (summary.schemaDraftCount > 0)
    return `${documents} · ${summary.schemaDraftCount} schema ${
      summary.schemaDraftCount === 1 ? 'draft' : 'drafts'
    }`
  return documents
}

/** What happened, in the domain's own words. */
const eventLabels: Record<ProjectContextActivityEvent['kind'], string> = {
  extraction_appended: 'Extraction appended',
  review_decisions_stored: 'Review Decisions stored',
  schema_revision_appended: 'Schema Revision appended',
  batch_extraction_opened: 'Batch Extraction opened',
}

/** The state color of a card's PhaseProgress bar, from the persisted summary. */
function summaryTone(summary: ProjectContext['summary']): PhaseProgressTone {
  if (summary.runningBatch) return 'running'
  if (summary.staleSourceDocumentCount > 0) return 'stale'
  if (
    summary.phase === 'validate' &&
    summary.extractedSourceDocumentCount > 0 &&
    summary.reviewedSourceDocumentCount === summary.extractedSourceDocumentCount
  )
    return 'validated'
  return 'progress'
}

/** "12 Aug 2026" — the quiet day-level timestamp the card state line shows. */
function activityDay(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/** Marks a Project Context row, echoing the rail's folder-shaped grouping. */
function FolderIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none">
      <path
        d="M2.5 5.5c0-.55.45-1 1-1h3.3c.32 0 .62.15.81.4l.88 1.2h8c.55 0 1 .45 1 1v7.4c0 .55-.45 1-1 1h-13c-.55 0-1-.45-1-1z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Shared column track, so the rows line up with their headings. */
const projectColumns =
  'grid-cols-1 sm:grid-cols-[minmax(0,1fr)_15rem_6.5rem]'

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
  const { projects, recentActivity, listState, retryList, createProject } =
    useProjectContexts()
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
      <div className="mx-auto w-full max-w-[1120px]">
        <div className="mb-10 flex items-end justify-between">
          <div className="flex flex-col gap-2">
            <h1 className="font-serif text-[32px] leading-none font-normal tracking-[-0.01em] text-ink">
              Projects
            </h1>
            {listState.status === 'ready' && (
              <p className="text-xs text-ink-faint">
                {projects.length} {projects.length === 1 ? 'project' : 'projects'}
              </p>
            )}
          </div>
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
          <div aria-busy="true">
            <p className="sr-only">Loading Project Contexts…</p>
            {/* Ghost rows on the real track, so loaded rows land without a jump. */}
            <ul aria-hidden="true" className="divide-y divide-line border-t border-line">
              {[0, 1, 2].map((slot) => (
                <li
                  key={slot}
                  className={`grid animate-pulse items-center gap-6 py-4 ${projectColumns}`}
                >
                  <span className="flex items-center gap-3.5">
                    <span className="size-9 shrink-0 rounded-card bg-surface-muted" />
                    <span className="h-3 w-2/5 rounded-xs bg-surface-muted" />
                  </span>
                  <span className="hidden h-0.5 bg-surface-muted sm:block" />
                  <span className="hidden h-3 rounded-xs bg-surface-muted sm:block" />
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="flex items-start gap-16">
            <div className="min-w-0 flex-1">
              <div
                aria-hidden="true"
                className={`grid items-center gap-6 border-b border-line pb-2 ${projectColumns}`}
              >
                <Overline>Project</Overline>
                <Overline className="hidden sm:block">Progress</Overline>
                <Overline className="hidden sm:block">Updated</Overline>
              </div>
              <ul className="divide-y divide-line">
                {projects.map((project) => (
                  <li key={project.projectContextId}>
                    {/* `-mx-2 px-2` keeps the hover fill wider than the row while
                        the row itself stays flush with its column headings. */}
                    <button
                      type="button"
                      aria-labelledby={`project-${project.projectContextId}-name`}
                      aria-describedby={`project-${project.projectContextId}-count`}
                      className={`-mx-2 grid w-[calc(100%+1rem)] cursor-pointer items-center gap-3 rounded-xs px-2 py-4 text-left outline-none hover:bg-line/20 focus-visible:ring-2 focus-visible:ring-accent/40 sm:gap-6 ${projectColumns}`}
                      onClick={() => open(project.projectContextId)}
                    >
                      <span className="flex min-w-0 items-center gap-3.5">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-card bg-accent-soft text-accent">
                          <FolderIcon />
                        </span>
                        <span className="min-w-0">
                          <h2
                            id={`project-${project.projectContextId}-name`}
                            className="truncate text-[12.5px] font-semibold text-ink"
                          >
                            {project.name}
                          </h2>
                          <span
                            id={`project-${project.projectContextId}-count`}
                            className="mt-1 block truncate text-[11px] text-ink-faint"
                          >
                            {metaLine(project)}
                          </span>
                        </span>
                      </span>
                      <PhaseProgress
                        className="w-full"
                        phase={project.summary.phase}
                        tone={summaryTone(project.summary)}
                        running={project.summary.runningBatch ?? undefined}
                      />
                      <span className="hidden text-[11px] text-ink-faint sm:block">
                        <time dateTime={project.summary.lastActivityAt}>
                          {activityDay(project.summary.lastActivityAt)}
                        </time>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            {/* No panel chrome and nothing at all when there is no activity. */}
            {recentActivity.length > 0 && (
              <aside
                aria-label="Recent activity"
                className="hidden w-[280px] shrink-0 flex-col gap-6 border-l border-line pl-8 lg:flex"
              >
                <Overline>Recent activity</Overline>
                <ul className="flex flex-col gap-5">
                  {recentActivity.map((event, index) => (
                    <li
                      key={`${event.kind}-${event.projectContextId}-${event.occurredAt}-${index}`}
                    >
                      <button
                        type="button"
                        className="group flex w-full cursor-pointer items-start gap-3 rounded-xs text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                        onClick={() => open(event.projectContextId)}
                      >
                        <span
                          aria-hidden="true"
                          className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-accent-soft"
                        >
                          <span className="size-1.5 rounded-full bg-accent" />
                        </span>
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-[12.5px] text-ink">
                            {eventLabels[event.kind]}
                          </span>
                          <span className="text-[11.5px] leading-relaxed text-ink-faint">
                            <span className="group-hover:underline">
                              {event.projectContextName}
                            </span>
                            {' · '}
                            <time dateTime={event.occurredAt}>
                              {activityDay(event.occurredAt)}
                            </time>
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </aside>
            )}
          </div>
        )}

        {createModal}
      </div>
    </div>
  )
}
