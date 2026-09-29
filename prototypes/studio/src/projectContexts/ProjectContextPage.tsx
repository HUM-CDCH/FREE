import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import type { NavigableRoute, ProjectResource } from '../projectNavigation'
import { projectContextNameSchema } from '../../shared/projectContext.contract'
import type { ProjectSpreadsheetVersion } from '../../shared/projectSpreadsheet.contract'
import type { BatchSchemaSuggestionPurpose } from '../../shared/batchSchemaSuggestion.contract'
import {
  deleteExtractionSchema,
  ExtractionSchemaHasExtractionsError,
  getSchemaRevision,
  listExtractionSchemas,
  listSchemaRevisions,
  renameExtractionSchema,
} from '../schemaRevisions'
import type { SchemaRevision } from '../../shared/schemaRevision.contract'
import SchemaNameEditor from '../SchemaNameEditor'
import SchemaPanel from '../SchemaPanel'
import {
  createSchemaEditorController,
  localSchemaPersistence,
} from '../currentSchemaRevision'
import { useSchemaEditorController } from '../useCurrentSchemaRevision'
import { Button, DeleteDialog, ModalDialog, EmptyState, GuidedNextStep } from '../ui'
import BatchExtractionsPanel, {
  SuggestedSchemaEditor,
} from './BatchExtractionsPanel'
import {
  getCurrentProjectSpreadsheet,
  uploadProjectSpreadsheet,
} from './batchExtractions'
import { useSpreadsheetSchemaSuggestion } from './useSpreadsheetSchemaSuggestion'
import { useSourceDocumentDownload } from './useSourceDocumentDownload'
import { useProjectContexts } from './useProjectContexts'
import ProjectWorkflowSteps from './ProjectWorkflowSteps'

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

// A schema's version history is fetched lazily, per schema, only once its
// row is expanded — most projects have one schema with a handful of
// revisions, so there's no need to fan out a request per schema on load.
type SchemaHistoryState =
  | { status: 'loading' }
  | { status: 'ready'; revisions: Awaited<ReturnType<typeof listSchemaRevisions>> }
  | { status: 'error'; message: string }

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
        aria-label="Project name"
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
        className="rounded-md p-1.5 leading-none text-accent outline-none transition-colors hover:bg-accent-soft disabled:opacity-60"
        type="submit"
        aria-label="Rename"
        title="Rename"
        disabled={saving || !named.success}
      >
        <span aria-hidden="true">✓</span>
      </button>
      <button
        className="rounded-md p-1.5 leading-none text-ink-muted outline-none transition-colors hover:bg-line/60 hover:text-ink disabled:opacity-60"
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

const FORMAT_EXAMPLE_COLUMNS = [
  'filename',
  'patient.name',
  'patient.address.city',
  'diagnosis.code',
]
const FORMAT_EXAMPLE_ROW = [
  'report-01.pdf',
  'Alex Rivera',
  'Boston',
  'J45.909',
]

/** Shows how a dot-separated header row nests into a hierarchical schema —
 *  triggered from the spreadsheet-import help link, since the mapping from
 *  flat columns to nested fields isn't obvious from prose alone. */
function SpreadsheetFormatExampleDialog({
  onDismiss,
  returnFocusRef,
}: {
  onDismiss: () => void
  returnFocusRef: RefObject<HTMLElement | null>
}) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)

  return (
    <ModalDialog
      className="m-auto w-full max-w-lg rounded-card border border-line bg-surface p-5 text-ink backdrop:bg-ink/55 backdrop:backdrop-blur-[2px]"
      labelledBy={titleId}
      initialFocusRef={closeRef}
      returnFocusRef={returnFocusRef}
      onDismiss={onDismiss}
    >
      <h2 id={titleId} className="text-sm font-bold text-ink">
        Nesting fields with a hierarchy separator
      </h2>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
        Set a separator (e.g. "."), then use it in column headers. Columns
        that share a prefix group into one nested field.
      </p>

      <div className="mt-3 overflow-x-auto rounded-md border border-line">
        <table className="w-full border-collapse text-[10.5px]">
          <thead>
            <tr>
              {FORMAT_EXAMPLE_COLUMNS.map((header) => (
                <th
                  key={header}
                  className="border-b border-line bg-accent-soft px-2 py-1 text-left font-mono font-semibold text-accent"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {FORMAT_EXAMPLE_ROW.map((value, index) => (
                <td
                  key={FORMAT_EXAMPLE_COLUMNS[index]}
                  className="px-2 py-1 text-ink"
                >
                  {value}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] font-semibold text-ink">Becomes:</p>
      <div className="mt-1 rounded-md border border-line bg-ink/[0.03] p-3 text-[11px] leading-relaxed text-ink">
        <ul className="space-y-1">
          <li>
            <span className="font-semibold">patient</span>
            <ul className="mt-1 space-y-1 border-l border-line pl-3">
              <li>
                name: <span className="text-ink-muted">Alex Rivera</span>
              </li>
              <li>
                <span className="font-semibold">address</span>
                <ul className="mt-1 space-y-1 border-l border-line pl-3">
                  <li>
                    city: <span className="text-ink-muted">Boston</span>
                  </li>
                </ul>
              </li>
            </ul>
          </li>
          <li>
            <span className="font-semibold">diagnosis</span>
            <ul className="mt-1 space-y-1 border-l border-line pl-3">
              <li>
                code: <span className="text-ink-muted">J45.909</span>
              </li>
            </ul>
          </li>
        </ul>
      </div>

      <div className="mt-4 flex justify-end">
        <Button ref={closeRef} size="md" onClick={onDismiss}>
          Got it
        </Button>
      </div>
    </ModalDialog>
  )
}

/** The read-only field editor for one loaded Schema Revision. A no-op,
 *  in-memory `localSchemaPersistence` controller — the same one
 *  `SuggestedSchemaEditor` uses for a not-yet-confirmed draft — lets
 *  `SchemaPanel` mount without the durable Batch Extraction machinery
 *  `RightRail` normally wires it through. */
function SchemaFieldsPreview({ revision }: { revision: SchemaRevision }) {
  const schema = useSchemaEditorController(() =>
    createSchemaEditorController(
      localSchemaPersistence({ onEdit: () => {} }),
      {
        initialDraft: {
          recordDescription: revision.recordDescription,
          schemaNodes: revision.schemaNodes,
        },
      },
    ),
  )
  return (
    <SchemaPanel
      schema={schema}
      onClearDraft={() => {}}
      sourceDocumentName=""
      readOnly
      showRegenerate={false}
    />
  )
}

type SchemaFieldsPreviewState =
  | { status: 'loading' }
  | { status: 'ready'; revision: SchemaRevision }
  | { status: 'error'; message: string }

function SchemaFieldsPreviewDialog({
  projectContextId,
  extractionSchemaId,
  schemaRevisionId,
  schemaName,
  onDismiss,
  returnFocusRef,
}: {
  projectContextId: string
  extractionSchemaId: string
  schemaRevisionId: string
  schemaName: string
  onDismiss: () => void
  returnFocusRef: RefObject<HTMLElement | null>
}) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const [state, setState] = useState<SchemaFieldsPreviewState>({
    status: 'loading',
  })

  useEffect(() => {
    const controller = new AbortController()
    getSchemaRevision(
      projectContextId,
      extractionSchemaId,
      schemaRevisionId,
      controller.signal,
    ).then(
      (revision) => {
        if (!controller.signal.aborted)
          setState({ status: 'ready', revision })
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            status: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Could not load this Schema Revision.',
          })
      },
    )
    return () => controller.abort()
  }, [projectContextId, extractionSchemaId, schemaRevisionId])

  return (
    <ModalDialog
      className="m-auto flex h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-card border border-line bg-surface p-5 text-ink backdrop:bg-ink/55 backdrop:backdrop-blur-[2px]"
      labelledBy={titleId}
      initialFocusRef={closeRef}
      returnFocusRef={returnFocusRef}
      onDismiss={onDismiss}
    >
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h2 id={titleId} className="text-sm font-bold text-ink">
          {schemaName} — fields
        </h2>
        <Button ref={closeRef} size="sm" onClick={onDismiss}>
          Close
        </Button>
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-hidden rounded-md border border-line bg-surface">
        {state.status === 'loading' && (
          <p className="p-4 text-xs text-ink-muted" aria-busy="true">
            Loading fields…
          </p>
        )}
        {state.status === 'error' && (
          <p className="p-4 text-xs text-danger" role="alert">
            {state.message}
          </p>
        )}
        {state.status === 'ready' && (
          <SchemaFieldsPreview revision={state.revision} />
        )}
      </div>
    </ModalDialog>
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
  // Guided next-step nudge (guided-pilot-extraction-workflow): fired once on
  // the live transition into "first document ingested" or "first schema
  // committed" — never on an initial load that already has either, so
  // reopening a project with existing work stays quiet.
  const [nudge, setNudge] = useState<'upload-complete' | 'schema-ready' | null>(null)
  const previousSourceDocumentCount = useRef<number | null>(null)
  const previousSchemaCount = useRef<number | null>(null)
  const generateSchemaSectionRef = useRef<HTMLElement>(null)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<'newest' | 'oldest' | 'name'>('newest')
  const [settledSchemaList, setSettledSchemaList] =
    useState<SchemaListState | null>(null)
  const [schemaRetry, setSchemaRetry] = useState(0)
  const schemaRequestKey = `${projectContextId}:${schemaRetry}`
  const [expandedSchemaHistory, setExpandedSchemaHistory] = useState<
    ReadonlySet<string>
  >(new Set())
  const [schemaHistory, setSchemaHistory] = useState<
    Record<string, SchemaHistoryState>
  >({})
  const [deletingSchema, setDeletingSchema] = useState<{
    extractionSchemaId: string
    name: string
    /** Set once a plain delete was refused for having Extractions — the
     *  dialog stays open with a stronger warning, and confirming again
     *  retries with `force: true`. */
    blocked: boolean
  } | null>(null)
  const [previewingSchema, setPreviewingSchema] = useState<{
    extractionSchemaId: string
    schemaRevisionId: string
    name: string
  } | null>(null)
  const schemaActionReturnFocus = useRef<HTMLElement>(null)
  const [spreadsheet, setSpreadsheet] = useState<
    | { status: 'loading' }
    | { status: 'ready'; version: ProjectSpreadsheetVersion | null }
    | { status: 'error'; message: string }
  >({ status: 'loading' })
  const [spreadsheetUploading, setSpreadsheetUploading] = useState(false)
  const [spreadsheetError, setSpreadsheetError] = useState<string | null>(null)
  const [spreadsheetDragging, setSpreadsheetDragging] = useState(false)
  const [showFormatExample, setShowFormatExample] = useState(false)
  const formatExampleTrigger = useRef<HTMLButtonElement>(null)
  const [separator, setSeparator] = useState('')
  const [spreadsheetPurpose, setSpreadsheetPurpose] =
    useState<BatchSchemaSuggestionPurpose>('SCHEMA')
  const [inferTypesFromValues, setInferTypesFromValues] = useState(true)
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
  // The detail read (`branch`) doesn't carry the persisted activity summary
  // (phase, schemaStabilised, …) — that only ever comes from the list read,
  // so it's looked up separately here regardless of which one supplied
  // `project` above.
  const projectSummary = projects.find(
    (candidate) => candidate.projectContextId === projectContextId,
  )?.summary
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

  async function uploadSpreadsheetFile(file: File) {
    setSpreadsheetUploading(true)
    setSpreadsheetError(null)
    try {
      const version = await uploadProjectSpreadsheet(projectContextId, file)
      setSpreadsheet({ status: 'ready', version })
    } catch (error) {
      setSpreadsheetError(
        error instanceof Error
          ? error.message
          : 'The spreadsheet could not be uploaded.',
      )
    } finally {
      setSpreadsheetUploading(false)
    }
  }

  function toggleSchemaHistory(extractionSchemaId: string) {
    setExpandedSchemaHistory((current) => {
      const next = new Set(current)
      if (next.has(extractionSchemaId)) next.delete(extractionSchemaId)
      else next.add(extractionSchemaId)
      return next
    })
    const loaded = schemaHistory[extractionSchemaId]
    if (loaded && loaded.status !== 'error') return
    setSchemaHistory((current) => ({
      ...current,
      [extractionSchemaId]: { status: 'loading' },
    }))
    listSchemaRevisions(projectContextId, extractionSchemaId).then(
      (revisions) => {
        setSchemaHistory((current) => ({
          ...current,
          [extractionSchemaId]: { status: 'ready', revisions },
        }))
      },
      (error: unknown) => {
        setSchemaHistory((current) => ({
          ...current,
          [extractionSchemaId]: {
            status: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Could not load version history.',
          },
        }))
      },
    )
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

  const [spreadsheetSuggestion, sendSpreadsheetSuggestion, createSchemaFromSpreadsheet] =
    useSpreadsheetSchemaSuggestion({
      projectContextId,
      onSuggestion: () => {},
      onRun: () => {
        setSchemaRetry((attempt) => attempt + 1)
        sendSpreadsheetSuggestion({ type: 'reset' })
      },
    })
  const activeSpreadsheetSuggestion = spreadsheetSuggestion.context.suggestion
  const spreadsheetDraftConflict = spreadsheetSuggestion.matches('conflict')
  const spreadsheetSuggestionConfirmed =
    activeSpreadsheetSuggestion?.confirmedSchemaRevisionId != null
  const updateSpreadsheetSuggestedDefinition = (
    update: (definition: NonNullable<typeof spreadsheetSuggestion.context.draft>) => NonNullable<typeof spreadsheetSuggestion.context.draft>,
  ) => {
    if (!spreadsheetSuggestion.context.draft) return
    sendSpreadsheetSuggestion({
      type: 'proposal.changed',
      definition: update(spreadsheetSuggestion.context.draft),
    })
  }

  const allSourceDocuments =
    branch?.status === 'ready' ? branch.detail.sourceDocuments : []

  useEffect(() => {
    if (tab !== 'schemas') return
    const controller = new AbortController()
    setSpreadsheet({ status: 'loading' })
    getCurrentProjectSpreadsheet(projectContextId, controller.signal).then(
      (version) => {
        if (controller.signal.aborted) return
        setSpreadsheet({ status: 'ready', version })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setSpreadsheet({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unknown error.',
        })
      },
    )
    return () => controller.abort()
  }, [projectContextId, tab, schemaRequestKey])

  // "First document ingested" -> nudge toward defining a schema.
  useEffect(() => {
    if (branch?.status !== 'ready') return
    const count = branch.detail.sourceDocuments.length
    const previous = previousSourceDocumentCount.current
    previousSourceDocumentCount.current = count
    if (previous === 0 && count > 0) setNudge('upload-complete')
  }, [branch])

  // "First Schema Revision committed" -> nudge toward piloting it. Going
  // back to zero schemas (the last one was just deleted) -> there's nothing
  // left in Schema history, so jump straight back to the chat step instead
  // of leaving the researcher looking at an empty list.
  useEffect(() => {
    if (schemaList?.status !== 'ready') return
    const count = schemaList.schemas.length
    const previous = previousSchemaCount.current
    previousSchemaCount.current = count
    if (previous === 0 && count > 0) setNudge('schema-ready')
    if (previous !== null && previous > 0 && count === 0)
      generateSchemaSectionRef.current?.focus()
  }, [schemaList])

  if (branch?.status === 'error')
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="flex flex-col items-center gap-4">
          <EmptyState
            className="max-w-sm bg-surface"
            icon="▢"
            title={
              branch.failure.code === 'not_found'
                ? 'That project no longer exists'
                : 'Could not load this project'
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
      <div
        className={
          isGridScreen
            ? 'flex w-full shrink-0 flex-col gap-6 px-4 pt-6 sm:px-8 sm:pt-8'
            : 'mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-6 px-4 pt-6 sm:p-8 sm:pb-0'
        }
      >
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
                {project?.name ?? 'Project'}
              </h1>
              <button
                ref={(button) => {
                  if (button && restoreRenameFocus.current) {
                    restoreRenameFocus.current = false
                    button.focus()
                  }
                  renameTrigger.current = button
                }}
                className="rounded-md p-1.5 text-ink-muted outline-none transition-colors hover:bg-accent-soft hover:text-accent disabled:opacity-60"
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
                className="rounded-md p-1.5 text-danger outline-none transition-colors hover:bg-danger/10 disabled:opacity-60"
                type="button"
                aria-label="Delete project"
                title="Delete project"
                onClick={() => setDeleting(true)}
                disabled={!project}
              >
                <TrashIcon />
              </button>
            </div>
          )}
        </header>

        {projectSummary && (
          <ProjectWorkflowSteps
            summary={projectSummary}
            activeTab={tab}
            onNavigate={(nextTab) =>
              onNavigate({ kind: 'project', projectContextId, tab: nextTab })
            }
          />
        )}

        <div className="flex items-end border-b border-line">
          <div
            className="flex gap-5"
            role="tablist"
            aria-label="Project resources"
          >
            {(['sources', 'schemas', 'extractions'] as const).map((value) => (
              <button
                key={value}
                id={`project-${value}-tab`}
                className={`border-b-2 px-0.5 pb-2 text-xs font-semibold capitalize outline-none transition-colors ${
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
            ? 'flex flex-col px-4 pb-6 sm:px-8 sm:pb-8'
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
            pilotSchemaRevisionId={
              resource.tab === 'extractions'
                ? (resource.pilotSchemaRevisionId ?? null)
                : null
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
            <section
              className="mb-6 space-y-3 border-b border-line pb-6"
              aria-label="Schema history"
            >
              <h2 className="text-xs font-bold text-ink">Schema history</h2>
              {schemaList?.status === 'ready' ? (
                schemaList.schemas.length === 0 ? (
                  <p className="text-[11px] text-ink-faint">
                    No schemas yet.
                  </p>
                ) : (
                  <ul className="divide-y divide-line">
                    {schemaList.schemas.map((schema) => {
                      const updatedAt =
                        schema.currentRevision?.createdAt ?? schema.createdAt
                      const expanded = expandedSchemaHistory.has(
                        schema.extractionSchemaId,
                      )
                      const history = schemaHistory[schema.extractionSchemaId]
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
                          <div className="mt-1.5 flex flex-wrap items-center gap-3">
                            <button
                              type="button"
                              onClick={() =>
                                toggleSchemaHistory(schema.extractionSchemaId)
                              }
                              aria-expanded={expanded}
                              className="text-[11px] font-semibold text-accent"
                            >
                              {expanded
                                ? 'Hide version history'
                                : 'Show version history'}
                            </button>
                            {schema.currentRevision && (
                              <button
                                type="button"
                                onClick={(event) => {
                                  schemaActionReturnFocus.current =
                                    event.currentTarget
                                  setPreviewingSchema({
                                    extractionSchemaId:
                                      schema.extractionSchemaId,
                                    schemaRevisionId:
                                      schema.currentRevision!.schemaRevisionId,
                                    name: schema.name,
                                  })
                                }}
                                className="text-[11px] font-semibold text-accent"
                              >
                                View fields
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={(event) => {
                                schemaActionReturnFocus.current =
                                  event.currentTarget
                                setDeletingSchema({
                                  extractionSchemaId:
                                    schema.extractionSchemaId,
                                  name: schema.name,
                                  blocked: false,
                                })
                              }}
                              className="text-[11px] font-semibold text-danger"
                            >
                              Delete
                            </button>
                          </div>
                          {expanded && (
                            <div className="mt-2 rounded-md border border-line bg-ink/[0.02] p-2">
                              {!history || history.status === 'loading' ? (
                                <p
                                  className="text-[11px] text-ink-muted"
                                  aria-busy="true"
                                >
                                  Loading versions…
                                </p>
                              ) : history.status === 'error' ? (
                                <p
                                  className="text-[11px] text-danger"
                                  role="alert"
                                >
                                  {history.message}
                                </p>
                              ) : (
                                <ul className="space-y-1.5">
                                  {history.revisions.map((revision) => (
                                    <li
                                      key={revision.schemaRevisionId}
                                      className="flex items-center justify-between gap-2 text-[11px]"
                                    >
                                      <span>
                                        <span className="font-semibold text-ink">
                                          v{revision.revisionNumber}
                                        </span>{' '}
                                        <span className="text-ink-muted">
                                          {new Date(
                                            revision.createdAt,
                                          ).toLocaleDateString(undefined, {
                                            dateStyle: 'medium',
                                          })}
                                        </span>
                                      </span>
                                      <span
                                        className={`rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold ${
                                          revision.stabilisedAt
                                            ? 'bg-green/10 text-green'
                                            : 'bg-accent-soft text-accent'
                                        }`}
                                      >
                                        {revision.stabilisedAt
                                          ? 'Stabilised'
                                          : 'Piloting'}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          )}
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
                  <Button onClick={() => setSchemaRetry((attempt) => attempt + 1)}>
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
            </section>

            <section
              ref={generateSchemaSectionRef}
              tabIndex={-1}
              className="mb-6 space-y-3 border-b border-line pb-6 outline-none"
              aria-label="From a document"
            >
              <h2 className="text-xs font-bold text-ink">
                Build your schema from a document
              </h2>
              <p className="text-[11px] text-ink-faint">
                Select a document to start with
              </p>

              {allSourceDocuments.length === 0 ? (
                <p className="text-[11px] text-ink-faint">
                  Upload a Source Document first, from the Sources tab.
                </p>
              ) : (
                <div className="max-h-40 overflow-y-auto rounded-md border border-line bg-surface p-1">
                  <ul className="space-y-1">
                    {allSourceDocuments.map((document) => (
                      <li key={document.sourceDocumentId}>
                        <button
                          type="button"
                          onClick={() =>
                            onNavigate({
                              kind: 'document',
                              projectContextId,
                              sourceDocumentId: document.sourceDocumentId,
                              fromSchemaBuilder: true,
                            })
                          }
                          className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-ink transition-colors hover:bg-accent-soft hover:text-accent"
                        >
                          <span className="min-w-0 truncate">
                            {document.name}
                          </span>
                          <span aria-hidden="true">→</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            <section
              className="mb-6 space-y-3 border-b border-line pb-6"
              aria-label="From a spreadsheet"
            >
              <h2 className="text-xs font-bold text-ink">
                Working from a spreadsheet? Upload it to start
              </h2>
              <button
                ref={formatExampleTrigger}
                type="button"
                onClick={() => setShowFormatExample(true)}
                className="text-[11px] font-semibold text-accent underline decoration-dotted underline-offset-2 outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                How should I format my spreadsheet?
              </button>
              {showFormatExample && (
                <SpreadsheetFormatExampleDialog
                  onDismiss={() => setShowFormatExample(false)}
                  returnFocusRef={formatExampleTrigger}
                />
              )}

              {spreadsheet.status === 'error' && (
                <p className="text-[11px] text-danger" role="alert">
                  Could not load this project's spreadsheet. {spreadsheet.message}
                </p>
              )}
              {spreadsheet.status === 'ready' && spreadsheet.version && (
                <p className="text-[11px] text-ink-faint">
                  Current spreadsheet:{' '}
                  <span className="font-semibold text-ink">
                    {spreadsheet.version.originalFilename}
                  </span>{' '}
                  (revision {spreadsheet.version.revisionNumber}, uploaded{' '}
                  {new Date(spreadsheet.version.createdAt).toLocaleDateString(
                    undefined,
                    { dateStyle: 'medium' },
                  )}
                  )
                </p>
              )}

              <div className="flex flex-col gap-3">
                <label
                  className={`flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-4 text-center text-xs font-semibold outline-none transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/40 ${
                    spreadsheetDragging
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-line-strong text-ink hover:border-accent'
                  }`}
                  onDragEnter={(event) => {
                    event.preventDefault()
                    setSpreadsheetDragging(true)
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={(event) => {
                    const next = event.relatedTarget
                    if (
                      !(next instanceof Node) ||
                      !event.currentTarget.contains(next)
                    )
                      setSpreadsheetDragging(false)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    setSpreadsheetDragging(false)
                    const file = event.dataTransfer.files[0]
                    if (file) uploadSpreadsheetFile(file)
                  }}
                >
                  {spreadsheetUploading
                    ? 'Uploading…'
                    : spreadsheet.status === 'ready' && spreadsheet.version
                      ? 'Drop to replace, or click to browse'
                      : 'Drop a spreadsheet here, or click to browse'}
                  <input
                    className="sr-only"
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    disabled={spreadsheetUploading}
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      event.target.value = ''
                      if (file) uploadSpreadsheetFile(file)
                    }}
                  />
                </label>

                <details className="text-[11px] text-ink-muted">
                  <summary className="cursor-pointer select-none font-semibold">
                    Options
                  </summary>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <label className="inline-flex items-center gap-1.5">
                      Hierarchy separator
                      <input
                        className="h-7 w-14 rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus-visible:border-accent"
                        type="text"
                        maxLength={1}
                        placeholder="none"
                        aria-label="Hierarchy separator (optional)"
                        value={separator}
                        onChange={(event) => setSeparator(event.target.value)}
                      />
                    </label>

                    <label
                      className="inline-flex items-center gap-1.5"
                      title="Requires a &quot;filename&quot; column matching each row to an uploaded document."
                    >
                      <input
                        type="checkbox"
                        checked={spreadsheetPurpose === 'SCHEMA_AND_VALIDATE'}
                        onChange={(event) =>
                          setSpreadsheetPurpose(
                            event.target.checked
                              ? 'SCHEMA_AND_VALIDATE'
                              : 'SCHEMA',
                          )
                        }
                      />
                      Also populate evaluation corpus from this spreadsheet
                    </label>

                    <label
                      className="inline-flex items-center gap-1.5"
                      title="When unchecked, every field is created as a plain string — only the header row is read, cell values are ignored."
                    >
                      <input
                        type="checkbox"
                        checked={inferTypesFromValues}
                        onChange={(event) =>
                          setInferTypesFromValues(event.target.checked)
                        }
                      />
                      Infer field types from spreadsheet values
                    </label>
                  </div>
                </details>

                <Button
                  size="sm"
                  className="self-start"
                  disabled={
                    spreadsheet.status !== 'ready' ||
                    !spreadsheet.version ||
                    !(
                      spreadsheetSuggestion.matches('idle') ||
                      spreadsheetSuggestion.matches('failed')
                    )
                  }
                  onClick={() =>
                    createSchemaFromSpreadsheet(
                      spreadsheetPurpose,
                      inferTypesFromValues,
                      separator.trim() || undefined,
                    )
                  }
                >
                  Generate schema suggestion
                </Button>
              </div>

              {spreadsheetError && (
                <p className="text-[11px] text-danger" role="alert">
                  {spreadsheetError}
                </p>
              )}
              {spreadsheetSuggestion.matches('creating') && (
                <p className="text-xs text-ink-muted" aria-busy="true">
                  Building…
                </p>
              )}
              {spreadsheetSuggestion.context.error && (
                <p className="text-[11px] text-danger" role="alert">
                  {spreadsheetSuggestion.context.error}
                </p>
              )}
              {spreadsheetDraftConflict && (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[11px] text-danger" role="alert">
                    This draft changed elsewhere. Reload before continuing.
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      sendSpreadsheetSuggestion({ type: 'suggestion.retry' })
                    }
                  >
                    Reload
                  </Button>
                </div>
              )}

              {spreadsheetSuggestion.context.draft && (
                <>
                  <div
                    className="h-[28rem] overflow-hidden rounded-md border border-line bg-surface"
                    aria-busy={spreadsheetSuggestion.matches('running')}
                    inert={spreadsheetSuggestion.matches('running') ? true : undefined}
                  >
                    <SuggestedSchemaEditor
                      key={activeSpreadsheetSuggestion?.batchSchemaSuggestionId}
                      proposal={spreadsheetSuggestion.context.draft}
                      proposalVersion={{
                        draftVersion: activeSpreadsheetSuggestion?.draftVersion ?? 0,
                        finishedAt: activeSpreadsheetSuggestion?.finishedAt ?? null,
                      }}
                      sourceDocumentName="Uploaded spreadsheet"
                      readOnly={spreadsheetSuggestionConfirmed}
                      showRegenerate={false}
                      onProposalEdit={updateSpreadsheetSuggestedDefinition}
                      onPendingLocalEditChange={() => {}}
                    />
                  </div>
                  {!spreadsheetSuggestionConfirmed && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() =>
                        sendSpreadsheetSuggestion({
                          type: 'run.requested',
                          strategy: 'ARTICLE',
                        })
                      }
                    >
                      Confirm schema
                    </Button>
                  )}
                </>
              )}
            </section>
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
                  className="h-9 w-full rounded-md border border-line bg-surface pl-9 pr-3 text-xs text-ink outline-none placeholder:text-ink-faint focus-visible:border-accent"
                  type="search"
                  aria-label="Filter sources"
                  placeholder="Filter sources"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </div>
              <select
                className="h-9 shrink-0 rounded-md border border-line bg-surface px-3 text-xs text-ink outline-none hover:border-line-strong focus-visible:border-accent"
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
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left outline-none transition-colors hover:bg-line/20"
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
                        className="flex size-8 cursor-pointer list-none items-center justify-center rounded-md text-ink-muted outline-none transition-colors hover:bg-line/60 hover:text-ink [&::-webkit-details-marker]:hidden"
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
          title="Delete project"
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
              queueMicrotask(() =>
                document.querySelector<HTMLElement>('[data-rail-toggle]')?.focus(),
              )
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
      {deletingSchema && (
        <DeleteDialog
          title="Delete schema"
          description={
            deletingSchema.blocked ? (
              <>
                “{deletingSchema.name}” has Extractions run against it.
                Deleting it anyway also permanently deletes those
                Extractions, along with its version history. This cannot be
                undone.
              </>
            ) : (
              <>
                Deleting “{deletingSchema.name}” permanently removes it and
                its version history. This cannot be undone.
              </>
            )
          }
          confirmLabel={deletingSchema.blocked ? 'Delete anyway' : undefined}
          onConfirm={async () => {
            try {
              await deleteExtractionSchema(
                projectContextId,
                deletingSchema.extractionSchemaId,
                { force: deletingSchema.blocked },
              )
              setSettledSchemaList((current) =>
                current?.status === 'ready' &&
                current.requestKey === schemaRequestKey
                  ? {
                      ...current,
                      schemas: current.schemas.filter(
                        (item) =>
                          item.extractionSchemaId !==
                          deletingSchema.extractionSchemaId,
                      ),
                    }
                  : current,
              )
              return null
            } catch (error) {
              if (
                error instanceof ExtractionSchemaHasExtractionsError &&
                !deletingSchema.blocked
              ) {
                setDeletingSchema({ ...deletingSchema, blocked: true })
                return { message: error.message }
              }
              return {
                message:
                  error instanceof Error
                    ? error.message
                    : 'Extraction Schema could not be deleted.',
              }
            }
          }}
          onCancel={() => setDeletingSchema(null)}
          returnFocusRef={schemaActionReturnFocus}
        />
      )}
      {previewingSchema && (
        <SchemaFieldsPreviewDialog
          projectContextId={projectContextId}
          extractionSchemaId={previewingSchema.extractionSchemaId}
          schemaRevisionId={previewingSchema.schemaRevisionId}
          schemaName={previewingSchema.name}
          onDismiss={() => setPreviewingSchema(null)}
          returnFocusRef={schemaActionReturnFocus}
        />
      )}
      {nudge === 'upload-complete' && (
        <GuidedNextStep
          title="Upload complete"
          description="Now tell the extractor what to look for: chat through a schema, or upload a spreadsheet of examples, on the Schemas tab."
          actionLabel="Go to Schemas"
          onAction={() => onNavigate({ kind: 'project', projectContextId, tab: 'schemas' })}
          onDismiss={() => setNudge(null)}
        />
      )}
      {nudge === 'schema-ready' && (
        <GuidedNextStep
          title="Schema saved"
          description="Pilot it before trusting it on the whole collection: on the Extractions tab, run a Batch Extraction over just 2-3 documents first."
          actionLabel="Go to Extractions"
          onAction={() => onNavigate({ kind: 'project', projectContextId, tab: 'extractions' })}
          onDismiss={() => setNudge(null)}
        />
      )}
    </div>
  )
}
