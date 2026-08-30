import { useEffect, useRef, useState } from 'react'
import type { NavigableRoute, ProjectResource } from '../projectNavigation'
import { projectContextNameSchema } from '../../shared/projectContext.contract'
import { listExtractionSchemas, renameExtractionSchema } from '../schemaRevisions'
import SchemaNameEditor from '../SchemaNameEditor'
import { Button, DeleteDialog, EmptyState } from '../ui'
import BatchExtractionsPanel from './BatchExtractionsPanel'
import { useSourceDocumentDownload } from './useSourceDocumentDownload'
import { useProjectContexts } from './useProjectContexts'

export type ProjectContextPageProps = {
  projectContextId: string
  /** The routed view. The route owns which resource tab is open, so a tab is
   * linkable, survives a refresh, and takes part in browser history. */
  resource: ProjectResource
  onNavigate: (route: NavigableRoute) => void
  /** Opening a Source Document from this page is a deliberate action, so it
   * opens as a pinned tab rather than a quick preview. */
  onOpenSourceDocument: (
    projectContextId: string,
    sourceDocumentId: string,
    name: string,
  ) => void
}

type SchemaListState =
  | {
      status: 'ready'
      requestKey: string
      schemas: Awaited<ReturnType<typeof listExtractionSchemas>>
    }
  | { status: 'error'; requestKey: string; message: string }

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
  onSubmit: (name: string) => Promise<{ message: string } | null>
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

function PencilIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 20 20"
      fill="currentColor"
    >
      <path d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793 3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
    </svg>
  )
}

function PdfIcon() {
  return (
    <span
      className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-[9px] font-bold tracking-tight text-danger"
      aria-hidden="true"
    >
      PDF
    </span>
  )
}

function TrashIcon() {
  return (
    <svg
      aria-hidden="true"
      width="15"
      height="15"
      viewBox="0 0 20 20"
      fill="none"
    >
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

function DownloadIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
    >
      <path
        d="M10 2.5v9m0 0 3.5-3.5M10 11.5 6.5 8M3.5 13.5v2.75c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25V13.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Managing one Project Context: its name, its Source Documents, and adding
 * more. An ingesting file renders as the same row it will become, so the list
 * never shows more entries than there are Source Documents-to-be.
 */
export default function ProjectContextPage({
  projectContextId,
  resource,
  onNavigate,
  onOpenSourceDocument,
}: ProjectContextPageProps) {
  const tab = resource.tab
  // The review grid is a spreadsheet: it earns the full viewport instead of
  // the reading-width column every other tab renders in.
  const isGridScreen = resource.tab === 'extractions' && resource.view === 'grid'
  const {
    projects,
    branches,
    loadBranch,
    renameProject,
    deleteProject,
    ingestingSources,
    addSources,
    retrySource,
    deleteSourceDocument,
  } = useProjectContexts()
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deletingSource, setDeletingSource] = useState<{
    sourceDocumentId: string
    name: string
  } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<'newest' | 'oldest' | 'name'>('newest')
  const [settledSchemaList, setSettledSchemaList] =
    useState<SchemaListState | null>(null)
  const [schemaRetry, setSchemaRetry] = useState(0)
  const schemaRequestKey = `${projectContextId}:${schemaRetry}`
  const schemaList =
    settledSchemaList?.requestKey === schemaRequestKey
      ? settledSchemaList
      : null
  const renameTrigger = useRef<HTMLButtonElement>(null)
  const deleteTrigger = useRef<HTMLButtonElement>(null)
  const deleteSourceReturnFocus = useRef<HTMLElement>(null)
  const restoreRenameFocus = useRef(false)
  const sourceListRef = useRef<HTMLUListElement>(null)
  const { downloadSource, downloadFailure } =
    useSourceDocumentDownload(projectContextId)
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
  const sourceDocuments =
    branch?.status === 'ready'
      ? branch.detail.sourceDocuments
          .filter((document) =>
            document.name
              .toLocaleLowerCase()
              .includes(filter.trim().toLocaleLowerCase()),
          )
          .toSorted((left, right) => {
            if (sort === 'name') return left.name.localeCompare(right.name)
            const difference =
              new Date(left.createdAt).getTime() -
              new Date(right.createdAt).getTime()
            return sort === 'oldest' ? difference : -difference
          })
      : []
  const sourceStatus =
    branch?.status === 'loading'
      ? 'Loading Source Documents…'
      : queued
          .map((source) =>
            source.status === 'failed'
              ? `${source.file.name}: failed. ${source.failure}`
              : `${source.file.name}: ${source.status}.`,
          )
          .join(' ')

  const addFiles = (files: readonly File[]) => {
    if (!files.length) return
    addSources(files.map((file) => ({ projectContextId, file })))
  }

  useEffect(() => {
    const closeOtherMenus = (event: PointerEvent) => {
      const openMenus = sourceListRef.current?.querySelectorAll('details[open]')
      openMenus?.forEach((details) => {
        if (!details.contains(event.target as Node)) {
          details.removeAttribute('open')
        }
      })
    }
    document.addEventListener('pointerdown', closeOtherMenus)
    return () => document.removeEventListener('pointerdown', closeOtherMenus)
  }, [])

  useEffect(() => {
    if (tab !== 'schemas') return
    const controller = new AbortController()
    listExtractionSchemas(projectContextId, undefined, controller.signal).then(
      (schemas) => {
        if (controller.signal.aborted) return
        setSettledSchemaList({
          status: 'ready',
          requestKey: schemaRequestKey,
          schemas,
        })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setSettledSchemaList({
          status: 'error',
          requestKey: schemaRequestKey,
          message: error instanceof Error ? error.message : 'Unknown error.',
        })
      },
    )
    return () => controller.abort()
  }, [projectContextId, schemaRequestKey, tab])

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
    <div className="scrollbar-subtle flex h-full flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-6 px-4 pt-6 sm:p-8 sm:pb-0">
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
                aria-label="Delete Project Context"
                title="Delete Project Context"
                onClick={() => setDeleting(true)}
                disabled={!project}
              >
                <TrashIcon />
              </button>
            </div>
          )}
        </header>

        <div className="flex items-end border-b border-line">
          <div
            className="flex gap-5"
            role="tablist"
            aria-label="Project resources"
          >
            {(['schemas', 'sources', 'extractions'] as const).map((value) => (
              <button
                key={value}
                id={`project-${value}-tab`}
                className={`border-b-2 px-0.5 pb-2 text-xs font-semibold capitalize outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  tab === value
                    ? 'border-accent text-ink'
                    : 'border-transparent text-ink-muted hover:text-ink'
                }`}
                type="button"
                role="tab"
                aria-selected={tab === value}
                aria-controls={`project-${value}-panel`}
                tabIndex={tab === value ? 0 : -1}
                // Reselecting the open tab would push a duplicate history
                // entry, which makes Back look broken.
                onClick={() => {
                  if (value !== tab)
                    onNavigate({ kind: 'project', projectContextId, tab: value })
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
                    return
                  event.preventDefault()
                  const sibling =
                    event.key === 'ArrowLeft'
                      ? (event.currentTarget.previousElementSibling ??
                        event.currentTarget.parentElement?.lastElementChild)
                      : (event.currentTarget.nextElementSibling ??
                        event.currentTarget.parentElement?.firstElementChild)
                  if (sibling instanceof HTMLButtonElement) {
                    sibling.click()
                    sibling.focus()
                  }
                }}
              >
                {value === 'schemas'
                  ? 'Schemas'
                  : value === 'sources'
                    ? 'Sources'
                    : 'Extractions'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div
        className={
          isGridScreen
            ? 'flex min-h-0 flex-1 flex-col px-4 pb-6 sm:px-8 sm:pb-8'
            : 'mx-auto w-full max-w-3xl flex-1 px-4 pb-28 sm:p-8 sm:pb-28'
        }
      >
        {tab === 'extractions' ? (
          <BatchExtractionsPanel
            // A different Project Context is different research state, never a
            // continuation of what this panel currently shows.
            key={projectContextId}
            projectContextId={projectContextId}
            sourceDocuments={
              branch?.status === 'ready' ? branch.detail.sourceDocuments : []
            }
            openBatchExtractionId={
              resource.tab === 'extractions'
                ? (resource.batchExtractionId ?? null)
                : null
            }
            openBatchExtractionView={
              resource.tab === 'extractions' ? (resource.view ?? null) : null
            }
            onNavigate={onNavigate}
          />
        ) : tab === 'schemas' ? (
          <div
            id="project-schemas-panel"
            role="tabpanel"
            aria-labelledby="project-schemas-tab"
            className="py-4"
            tabIndex={0}
          >
            {schemaList?.status === 'ready' ? (
              schemaList.schemas.length === 0 ? (
                <p className="py-6 text-center text-xs text-ink-muted">
                  No schemas yet.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {schemaList.schemas.map((schema) => {
                    const updatedAt =
                      schema.currentRevision?.createdAt ?? schema.createdAt
                    return (
                      <li className="px-1 py-3" key={schema.extractionSchemaId}>
                        <SchemaNameEditor
                          name={schema.name}
                          className="text-xs font-semibold text-ink"
                          onSubmit={async (name) => {
                            try {
                              const renamed = await renameExtractionSchema(
                                projectContextId,
                                schema.extractionSchemaId,
                                name,
                              )
                              setSettledSchemaList((current) =>
                                current?.status === 'ready' &&
                                current.requestKey === schemaRequestKey
                                  ? {
                                      ...current,
                                      schemas: current.schemas.map((item) =>
                                        item.extractionSchemaId ===
                                        renamed.extractionSchemaId
                                          ? { ...item, name: renamed.name }
                                          : item,
                                      ),
                                    }
                                  : current,
                              )
                              return null
                            } catch (error) {
                              return error instanceof Error
                                ? error.message
                                : 'Schema could not be renamed.'
                            }
                          }}
                        />
                        <dl className="mt-1 flex gap-3 text-[11px] text-ink-faint">
                          <div>
                            <dt className="sr-only">Current Schema Revision</dt>
                            <dd>
                              {schema.currentRevision
                                ? `Current Schema Revision ${schema.currentRevision.revisionNumber}`
                                : 'No Current Schema Revision'}
                            </dd>
                          </div>
                          <div>
                            <dt className="sr-only">Updated</dt>
                            <dd>
                              <time dateTime={updatedAt}>
                                Updated{' '}
                                {new Date(updatedAt).toLocaleDateString(
                                  undefined,
                                  {
                                    dateStyle: 'medium',
                                  },
                                )}
                              </time>
                            </dd>
                          </div>
                        </dl>
                      </li>
                    )
                  })}
                </ul>
              )
            ) : schemaList?.status === 'error' ? (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <p className="text-xs text-danger" role="alert">
                  Could not load schemas. {schemaList.message}
                </p>
                <Button
                  onClick={() => setSchemaRetry((attempt) => attempt + 1)}
                >
                  Retry
                </Button>
              </div>
            ) : (
              <p
                className="py-6 text-center text-xs text-ink-muted"
                aria-busy="true"
              >
                Loading schemas…
              </p>
            )}
          </div>
        ) : (
          <div
            id="project-sources-panel"
            role="tabpanel"
            aria-labelledby="project-sources-tab"
          >
            <p className="sr-only" role="status" aria-atomic="true">
              {sourceStatus}
            </p>
            <label
              className={`flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed px-6 py-8 text-center outline-none transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/40 ${
                dragging
                  ? 'border-accent bg-accent-soft'
                  : 'border-line-strong hover:border-accent'
              }`}
              onDragEnter={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                const next = event.relatedTarget
                if (
                  !(next instanceof Node) ||
                  !event.currentTarget.contains(next)
                )
                  setDragging(false)
              }}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                // The server owns file validation so invalid uploads remain
                // visible, retryable failures instead of disappearing here.
                addFiles(Array.from(event.dataTransfer.files))
              }}
            >
              <span
                id="project-source-drop-label"
                className="text-sm font-semibold text-ink"
              >
                Drop PDFs here or browse
              </span>
              <input
                className="sr-only"
                type="file"
                accept=".pdf,application/pdf"
                aria-labelledby="project-source-drop-label"
                multiple
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? [])
                  event.target.value = ''
                  addFiles(files)
                }}
              />
            </label>

            <div className="mt-3 flex items-center gap-3">
              <div className="relative min-w-0 flex-1">
                <svg
                  aria-hidden="true"
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
                  width="14"
                  height="14"
                  viewBox="0 0 20 20"
                  fill="none"
                >
                  <circle
                    cx="8.5"
                    cy="8.5"
                    r="5.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <path
                    d="m13 13 4 4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
                <input
                  className="h-9 w-full rounded-md border border-line bg-surface pl-9 pr-3 text-xs text-ink outline-none placeholder:text-ink-faint focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent"
                  type="search"
                  aria-label="Filter sources"
                  placeholder="Filter sources"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </div>
              <select
                className="h-9 shrink-0 rounded-md border border-line bg-surface px-3 text-xs text-ink outline-none hover:border-line-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
                aria-label="Sort sources"
                value={sort}
                onChange={(event) => setSort(event.target.value as typeof sort)}
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="name">Name</option>
              </select>
            </div>

            {downloadFailure && (
              <p className="mt-3 text-xs text-danger" role="alert">
                {downloadFailure}
              </p>
            )}

            {branch?.status === 'loading' && (
              <p className="py-4 text-xs text-ink-muted" aria-busy="true">
                Loading Source Documents…
              </p>
            )}

            {(queued.length > 0 || branch?.status === 'ready') && (
              <ul className="divide-y divide-line" ref={sourceListRef}>
                {/* In-flight first: new work stays visible without scrolling. */}
                {queued.map((source) => (
                  <li
                    className="flex items-center gap-3 px-1 py-3"
                    key={source.ingestionKey}
                  >
                    <PdfIcon />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-ink">
                        {source.file.name}
                      </span>
                      {source.status === 'failed' ? (
                        <span className="block text-[11px] leading-snug text-danger">
                          {source.failure}
                        </span>
                      ) : (
                        <span className="block text-[11px] text-ink-faint">
                          <span>
                            {source.status === 'parsing'
                              ? 'Parsing…'
                              : 'Queued'}
                          </span>
                        </span>
                      )}
                    </span>
                    {source.status === 'failed' &&
                      source.validationFailure === undefined && (
                      <Button
                        onClick={() => retrySource(source.ingestionKey)}
                        aria-label={`Retry ${source.file.name}`}
                      >
                        Retry
                      </Button>
                      )}
                  </li>
                ))}
                {sourceDocuments.map((document) => (
                  <li
                    className="flex items-center px-1 py-3"
                    key={document.sourceDocumentId}
                  >
                    <button
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left outline-none transition-colors hover:bg-line/20 focus-visible:ring-1 focus-visible:ring-accent"
                      type="button"
                      onClick={() =>
                        onOpenSourceDocument(
                          projectContextId,
                          document.sourceDocumentId,
                          document.name,
                        )
                      }
                    >
                      <PdfIcon />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold text-ink">
                          {document.name}
                        </span>
                        <span className="block text-[11px] text-ink-faint">
                          {document.pageCount !== null && (
                            <>
                              {document.pageCount}{' '}
                              {document.pageCount === 1 ? 'page' : 'pages'}
                              {' · '}
                            </>
                          )}
                          {new Date(document.createdAt).toLocaleDateString(
                            undefined,
                            { dateStyle: 'medium' },
                          )}
                        </span>
                      </span>
                    </button>
                    <details className="relative ml-2 shrink-0">
                      <summary
                        className="flex size-8 cursor-pointer list-none items-center justify-center rounded-md text-ink-muted outline-none transition-colors hover:bg-line/60 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 [&::-webkit-details-marker]:hidden"
                        aria-label={`Actions for ${document.name}`}
                      >
                        <span aria-hidden="true">•••</span>
                      </summary>
                      <div className="absolute right-0 top-9 z-10 w-36 rounded-2xl bg-ink p-1.5 text-xs text-white shadow-lg">
                        <button
                          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"
                          type="button"
                          aria-label={`Download ${document.name}`}
                          onClick={(event) => {
                            event.currentTarget
                              .closest('details')
                              ?.removeAttribute('open')
                            void downloadSource(
                              document.sourceDocumentId,
                              document.name,
                            )
                          }}
                        >
                          <DownloadIcon />
                          Download
                        </button>
                        <button
                          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-danger hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"
                          type="button"
                          aria-label={`Delete Source Document ${document.name}`}
                          onClick={(event) => {
                            const details =
                              event.currentTarget.closest('details')
                            deleteSourceReturnFocus.current =
                              details?.querySelector('summary') ?? null
                            details?.removeAttribute('open')
                            setDeletingSource({
                              sourceDocumentId: document.sourceDocumentId,
                              name: document.name,
                            })
                          }}
                        >
                          <TrashIcon />
                          Delete
                        </button>
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            )}
            {branch?.status === 'ready' &&
              sourceDocuments.length === 0 &&
              queued.length === 0 &&
              (filter ? (
                <p className="py-8 text-center text-xs text-ink-muted">
                  No sources match “{filter}”.
                </p>
              ) : (
                <p className="py-8 text-center text-xs text-ink-muted">
                  No Source Documents yet. Drop PDFs above to get started.
                </p>
              ))}
          </div>
        )}
      </div>

      {deleting && project && (
        <DeleteDialog
          title="Delete Project Context"
          description={
            <>
              Deleting “{project.name}” permanently removes its Source
              Documents, Annotations, Extraction Schema, Extractions, and Review
              Decisions. This cannot be undone.
            </>
          }
          onConfirm={async () => {
            const rejected = await deleteProject(projectContextId)
            // The page's own Project Context is gone; nothing here can survive
            // it, so focus moves to the always-mounted rail toggle instead of
            // dropping onto <body>.
            if (!rejected) {
              onNavigate({ kind: 'root' })
              document.querySelector<HTMLElement>('[data-rail-toggle]')?.focus()
            }
            return rejected
          }}
          onCancel={() => {
            setDeleting(false)
            deleteTrigger.current?.focus()
          }}
        />
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
              projectContextId,
              deletingSource.sourceDocumentId,
            )
          }
          onCancel={() => setDeletingSource(null)}
          returnFocusRef={deleteSourceReturnFocus}
        />
      )}
    </div>
  )
}
