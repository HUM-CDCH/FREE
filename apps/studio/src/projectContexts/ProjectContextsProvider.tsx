import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useMachine } from '@xstate/react'
import { sourceIngestionMachine } from '../sourceIngestionMachine'
import { isLiveIngestion, MAX_NAMED_INGESTIONS } from '../../shared/sourceDocumentIngestion.contract'
import { startIngestionPolling, type IngestionPoller, type IngestionReading } from './ingestionPolling'
import {
  createProjectContext,
  deleteProjectContext,
  deleteSourceDocument,
  dismissSourceIngestion,
  getProjectContextWithDocuments,
  ingestSourceDocument,
  listSourceIngestions,
  reprocessSourceDocument,
  listProjectContexts,
  renameProjectContext,
  provisionalSummary,
  toProjectContextFailure as failure,
  uncertainFailure,
  type ProjectContext,
  type ProjectContextActivityEvent,
} from './transport'
import {
  ProjectContextsContext,
  type ProjectBranch,
  type ProjectIngestions,
  type ProjectContextsValue,
  type WriteResult,
} from './useProjectContexts'
import type { SourceDocumentReprocessResponse } from '../../shared/sourceDocumentReprocess.contract'
import { sourceDocumentFilenameFailure } from '../../shared/sourceDocumentFilename'

function withSourceDocumentCount(
  projects: ProjectContext[],
  projectContextId: string,
  sourceDocumentCount: number,
): ProjectContext[] {
  const project = projects.find(
    (item) => item.projectContextId === projectContextId,
  )
  if (!project || project.sourceDocumentCount === sourceDocumentCount)
    return projects
  return projects.map((item) =>
    item.projectContextId === projectContextId
      ? { ...item, sourceDocumentCount }
      : item,
  )
}

/**
 * Owns the Project Context list, the id-keyed branch cache, and acknowledged
 * writes. Every applied write bumps a generation; a read that started under an
 * older generation predates acknowledged truth, so its payload is never merged
 * — it would resurrect a deleted Project Context or an old name. Branch reads
 * intentionally outlive collapse and unmount; the fence, not an abort, keeps
 * them honest.
 */
export function ProjectContextsProvider({ children }: { children: ReactNode }) {
  const [sourceRevisions, setSourceRevisions] = useState<
    Record<string, string>
  >({})
  const [projects, setProjects] = useState<ProjectContext[]>([])
  const [recentActivity, setRecentActivity] = useState<
    ProjectContextActivityEvent[]
  >([])
  const [listState, setListState] = useState<ProjectContextsValue['listState']>(
    { status: 'loading' },
  )
  const [branches, setBranches] = useState<
    Readonly<Record<string, ProjectBranch>>
  >({})
  const branchesRef = useRef(branches)
  const generation = useRef(0)
  const branchGenerations = useRef<Record<string, number>>({})
  const reloadBranch = useRef<(projectContextId: string) => void>(() => {})
  const reloadList = useRef<() => void>(() => {})
  // Run once the next read of that branch settles (a superseded read re-issues itself first).
  const branchSettled = useRef(new Map<string, ((read: boolean) => void)[]>())
  const settleBranch = (projectContextId: string, read: boolean) => {
    const callbacks = branchSettled.current.get(projectContextId) ?? []
    branchSettled.current.delete(projectContextId)
    for (const callback of callbacks) callback(read)
  }

  // `background`: keep a ready branch on screen while it is re-read, as a completed Source Ingestion does.
  const loadBranch = useCallback((projectContextId: string, retry = false, background = false) => {
    const branch = branchesRef.current[projectContextId]
    if (!retry && (branch?.status === 'loading' || branch?.status === 'ready'))
      return
    const startedAt = generation.current
    const branchStartedAt = branchGenerations.current[projectContextId] ?? 0
    // A superseded read is dropped, then re-issued — unless the write that
    // superseded it was the deletion of this very Project Context.
    const superseded = () => {
      const branchGeneration = branchGenerations.current[projectContextId] ?? 0
      if (
        startedAt === generation.current &&
        branchStartedAt === branchGeneration
      )
        return false
      if (branchesRef.current[projectContextId])
        reloadBranch.current(projectContextId)
      return true
    }
    if (!(background && branch?.status === 'ready')) {
      branchesRef.current = {
        ...branchesRef.current,
        [projectContextId]: { status: 'loading' },
      }
      setBranches(branchesRef.current)
    }
    void getProjectContextWithDocuments(projectContextId).then(
      (detail) => {
        if (superseded()) return
        settleBranch(projectContextId, true)
        branchesRef.current = {
          ...branchesRef.current,
          [projectContextId]: { status: 'ready', detail },
        }
        setBranches(branchesRef.current)
        const sourceDocumentCount = detail.sourceDocuments.length
        // Preserve a routed Project Context resolved before recents finish,
        // and keep the list summary aligned with any branch read.
        setProjects((current) =>
          current.some(
            (project) => project.projectContextId === projectContextId,
          )
            ? withSourceDocumentCount(
                current,
                projectContextId,
                sourceDocumentCount,
              )
            : [
                ...current,
                {
                  ...detail.projectContext,
                  sourceDocumentCount,
                  summary: provisionalSummary(
                    detail.projectContext.createdAt,
                    sourceDocumentCount,
                  ),
                },
              ],
        )
      },
      (error: unknown) => {
        if (superseded()) return
        settleBranch(projectContextId, false)
        // A background re-read that fails keeps what the researcher already sees.
        if (background && branchesRef.current[projectContextId]?.status === 'ready') return
        branchesRef.current = {
          ...branchesRef.current,
          [projectContextId]: { status: 'error', failure: failure(error) },
        }
        setBranches(branchesRef.current)
      },
    )
  }, [])
  // Held in a ref so a superseded read can re-issue itself without making
  // `loadBranch` depend on its own identity.
  useEffect(() => {
    reloadBranch.current = (projectContextId) =>
      loadBranch(projectContextId, true, true)
  }, [loadBranch])

  const readProjects = useCallback((controller: AbortController) => {
    const startedAt = generation.current
    void listProjectContexts(controller.signal).then(
      ({ projectContexts: recent, recentActivity: activity }) => {
        if (controller.signal.aborted) return
        // Re-read after an acknowledged write: merging this older snapshot
        // would either revert a name or resurrect a deleted Project Context.
        if (startedAt !== generation.current) return reloadList.current()
        // Preserve an older routed Project Context resolved before recents finish.
        setProjects((current) => [
          ...recent,
          ...current.filter(
            (project) =>
              !recent.some(
                (item) => item.projectContextId === project.projectContextId,
              ),
          ),
        ])
        setRecentActivity(activity)
        setListState({ status: 'ready' })
      },
      (error: unknown) => {
        if (startedAt !== generation.current) return reloadList.current()
        if (!controller.signal.aborted)
          setListState({ status: 'error', failure: failure(error) })
      },
    )
  }, [])

  useEffect(() => {
    reloadList.current = () => readProjects(new AbortController())
  }, [readProjects])

  useEffect(() => {
    const controller = new AbortController()
    readProjects(controller)
    return () => controller.abort()
  }, [readProjects])

  const retryList = useCallback(() => {
    setListState({ status: 'loading' })
    readProjects(new AbortController())
  }, [readProjects])

  const refreshProjects = useCallback(() => {
    readProjects(new AbortController())
  }, [readProjects])

  const setBranch = useCallback(
    (projectContextId: string, branch: ProjectBranch | null) => {
      const next = { ...branchesRef.current }
      if (branch) next[projectContextId] = branch
      else delete next[projectContextId]
      branchesRef.current = next
      setBranches(next)
    },
    [],
  )

  // Every write applies to the rail only after the server acknowledges it, so a
  // failure leaves the rail exactly as the researcher last saw it.
  const createProject = useCallback(
    async (name: string): ReturnType<ProjectContextsValue['createProject']> => {
      try {
        const acknowledged = await createProjectContext(name)
        const created = {
          ...acknowledged,
          sourceDocumentCount: 0,
          summary: provisionalSummary(acknowledged.createdAt, 0),
        }
        generation.current += 1
        setProjects((current) => [created, ...current])
        return { created }
      } catch (error) {
        return { failure: failure(error) }
      }
    },
    [],
  )

  const renameProject = useCallback(
    async (projectContextId: string, name: string): WriteResult => {
      try {
        const renamed = await renameProjectContext(projectContextId, name)
        generation.current += 1
        setProjects((current) =>
          current.map((project) =>
            project.projectContextId === projectContextId
              ? { ...project, ...renamed }
              : project,
          ),
        )
        const branch = branchesRef.current[projectContextId]
        if (branch?.status === 'ready')
          setBranch(projectContextId, {
            status: 'ready',
            detail: { ...branch.detail, projectContext: renamed },
          })
        return null
      } catch (error) {
        return failure(error)
      }
    },
    [setBranch],
  )

  // An acknowledged ingestion is durable truth the rail may not have read yet.
  // A read of this branch already in flight predates the write, so it is fenced
  // and re-issued rather than showing the branch without its new Source
  // Document. Only this branch's read is fenced: researchers browse other
  // Project Contexts while the queue runs, and their reads are not stale.
  const acknowledgeSourceDocument = useCallback(
    (projectContextId: string, document: SourceDocumentReprocessResponse) => {
      const branch = branchesRef.current[projectContextId]
      // A read in flight predates this write, whether it shows `loading` or is a background re-read of a ready
      // branch: fence it, and it re-issues itself.
      if (branch)
        branchGenerations.current[projectContextId] =
          (branchGenerations.current[projectContextId] ?? 0) + 1
      if (branch?.status !== 'ready') {
        reloadList.current()
        return
      }
      const sourceDocuments = [
        ...branch.detail.sourceDocuments.filter(
          (item) => item.sourceDocumentId !== document.sourceDocumentId,
        ),
        {
          sourceDocumentId: document.sourceDocumentId,
          name: document.name,
          createdAt: document.createdAt,
          pageCount: document.pageCount,
        },
      ].sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.sourceDocumentId.localeCompare(right.sourceDocumentId),
      )
      setProjects((current) =>
        withSourceDocumentCount(
          current,
          projectContextId,
          sourceDocuments.length,
        ),
      )
      setBranch(projectContextId, {
        status: 'ready',
        detail: { ...branch.detail, sourceDocuments },
      })
      // `sourceDocumentCount` is patched in locally above for an instant
      // count, but the first ingested Source Document also moves this
      // Project Context's persisted phase (ingest -> chat) — a value only
      // the list read carries. Without this, the stepper and its "Next"
      // button keep showing "Upload" as current until something else
      // happens to refetch the list.
      reloadList.current()
    },
    [setBranch],
  )

  // The send queue lives here, not in a page: it must keep sending while the
  // researcher navigates between Source Documents and Project Contexts.
  const [ingestion, sendIngestion, ingestionActor] = useMachine(sourceIngestionMachine, {
    input: {
      ingest: (source) => {
        if (source.kind === 'reprocess') throw new Error('A reprocess is not an upload.')
        return ingestSourceDocument(source.projectContextId, source.file, source.layout)
      },
      reprocess: (source) => {
        if (source.kind !== 'reprocess') throw new Error('An upload is not a reprocess.')
        // The server owns reprocessing once POSTed; actor shutdown only ignores its result.
        return reprocessSourceDocument(source.projectContextId, source.sourceDocumentId, {
          requestKey: source.requestKey,
          expectedRepresentationId: source.expectedRepresentationId,
          layout: source.layout,
        })
      },
      toFailureMessage: (error) => failure(error).message,
      isUncertain: uncertainFailure,
      onAdmitted: (item) => {
        ensurePolling.current(item.projectContextId)
        pollers.current.get(item.projectContextId)?.readNow()
      },
      onReplayed: (item, document) => acknowledgeSourceDocument(item.projectContextId, document),
      onIngested: ({ item, result }) => {
        acknowledgeSourceDocument(item.projectContextId, result)
        if (item.kind === 'reprocess') {
          setSourceRevisions((current) => ({
            ...current,
            [item.sourceDocumentId]: result.sourceRepresentationId,
          }))
          reloadList.current()
        }
      },
    },
  })

  // Studio's Source Ingestions, per observed Project Context. The listing is the queue; the machine above only sends.
  const [ingestions, setIngestions] = useState<Readonly<Record<string, ProjectIngestions>>>({})
  const ingestionsRef = useRef(ingestions)
  const pollers = useRef(new Map<string, IngestionPoller>())
  const observers = useRef(new Map<string, number>())
  // Per project: the attempts live in the last listing, named again until they resolve.
  const watched = useRef(new Map<string, ReadonlySet<string>>())
  const refreshing = useRef(new Set<string>())
  // Successes a branch read has already answered: the branch is the authority (its document may since be deleted).
  const reconciled = useRef(new Set<string>())
  const setProjectIngestions = useCallback((projectContextId: string, next: ProjectIngestions | null) => {
    const updated = { ...ingestionsRef.current }
    if (next) updated[projectContextId] = next
    else delete updated[projectContextId]
    ingestionsRef.current = updated
    setIngestions(updated)
  }, [])
  /** This tab's admitted uploads for the project, then the previous listing's live attempts. */
  const named = useCallback((projectContextId: string): string[] => {
    const admitted = ingestionActor.getSnapshot().context.items.flatMap((item) =>
      item.kind !== 'reprocess' && item.status === 'admitted' && item.projectContextId === projectContextId && item.workflowId
        ? [item.workflowId]
        : [])
    return [...new Set([...admitted, ...(watched.current.get(projectContextId) ?? [])])].slice(0, MAX_NAMED_INGESTIONS)
  }, [ingestionActor])
  const stopPolling = useCallback((projectContextId: string) => {
    pollers.current.get(projectContextId)?.stop()
    pollers.current.delete(projectContextId)
  }, [])
  const liveListed = useCallback((projectContextId: string) =>
    ingestionsRef.current[projectContextId]?.ingestions.some(isLiveIngestion) ?? false, [])
  /** A listed success whose Source Document the branch does not hold yet: the next read retries the refresh. */
  const unreconciled = useCallback((projectContextId: string) => {
    const branch = branchesRef.current[projectContextId]
    const held = new Set(branch?.status === 'ready' ? branch.detail.sourceDocuments.map((document) => document.sourceDocumentId) : [])
    return ingestionsRef.current[projectContextId]?.ingestions.some((row) =>
      row.status === 'succeeded' && !held.has(row.sourceDocumentId) && !reconciled.current.has(row.workflowId)) ?? false
  }, [])
  const busy = useCallback((projectContextId: string) =>
    liveListed(projectContextId) || named(projectContextId).length > 0 || unreconciled(projectContextId),
  [liveListed, named, unreconciled])
  const stopIfIdle = useCallback((projectContextId: string) => {
    if (!observers.current.get(projectContextId) && !busy(projectContextId)) stopPolling(projectContextId)
  }, [busy, stopPolling])
  // A completion is reconciled once the branch holds its Source Document, so a failed re-read simply tries again.
  // Only this branch is fenced: other Project Contexts' reads are not stale.
  const refreshAfterIngestion = useCallback((projectContextId: string) => {
    if (refreshing.current.has(projectContextId)) return
    refreshing.current.add(projectContextId)
    // The successes this refresh answers; a failed read answers none, so the next listing retries.
    const answers = (ingestionsRef.current[projectContextId]?.ingestions ?? [])
      .filter((row) => row.status === 'succeeded').map((row) => row.workflowId)
    const settled = (read: boolean) => {
      refreshing.current.delete(projectContextId)
      if (read) for (const workflowId of answers) reconciled.current.add(workflowId)
    }
    branchGenerations.current[projectContextId] = (branchGenerations.current[projectContextId] ?? 0) + 1
    if (branchesRef.current[projectContextId]) {
      branchSettled.current.set(projectContextId, [...(branchSettled.current.get(projectContextId) ?? []), settled])
      loadBranch(projectContextId, true, true)
    } else settled(false)
    reloadList.current()
  }, [loadBranch])
  const onReading = useCallback((projectContextId: string, reading: IngestionReading) => {
    if (reading.kind === 'gone') {
      stopPolling(projectContextId)
      watched.current.delete(projectContextId)
      setProjectIngestions(projectContextId, null)
      // Deleted in another tab: drop local ownership too, as a local deletion does.
      sendIngestion({ type: 'project.deleted', projectContextId })
      return
    }
    const current = ingestionsRef.current[projectContextId]
    if (reading.kind === 'unavailable') {
      setProjectIngestions(projectContextId, {
        status: current ? current.status : 'unavailable', ingestions: current?.ingestions ?? [], stale: true,
      })
      return
    }
    const { ingestions: listed, absent } = reading.listing
    sendIngestion({ type: 'ingestions.observed', projectContextId, workflowIds: listed.map((row) => row.workflowId), absent })
    watched.current.set(projectContextId, new Set(listed.filter(isLiveIngestion).map((row) => row.workflowId)))
    setProjectIngestions(projectContextId, { status: 'ready', ingestions: listed, stale: false })
    if (unreconciled(projectContextId)) refreshAfterIngestion(projectContextId)
    stopIfIdle(projectContextId)
  }, [refreshAfterIngestion, sendIngestion, setProjectIngestions, stopIfIdle, stopPolling, unreconciled])
  // Held in a ref: the machine's callbacks are fixed when it starts.
  const ensurePolling = useRef<(projectContextId: string) => void>(() => {})
  useEffect(() => {
    ensurePolling.current = (projectContextId) => {
      if (pollers.current.has(projectContextId)) return
      pollers.current.set(projectContextId, startIngestionPolling({
        list: (signal) => listSourceIngestions(projectContextId, named(projectContextId), signal),
        busy: () => busy(projectContextId),
        onReading: (reading) => onReading(projectContextId, reading),
      }))
    }
    // A page that mounts in the provider's own first commit observed before this effect ran (child effects run
    // first), so its call reached the initial no-op: start what is already observed.
    for (const [projectContextId, count] of observers.current)
      if (count > 0) ensurePolling.current(projectContextId)
  }, [busy, named, onReading])
  useEffect(() => () => {
    for (const poller of pollers.current.values()) poller.stop()
    pollers.current.clear()
  }, [])

  const observeIngestions = useCallback((projectContextId: string) => {
    const count = (observers.current.get(projectContextId) ?? 0) + 1
    observers.current.set(projectContextId, count)
    // A cached branch may predate work that finished while nothing observed this project.
    if (count === 1 && branchesRef.current[projectContextId]?.status === 'ready') loadBranch(projectContextId, true, true)
    ensurePolling.current(projectContextId)
    return () => {
      observers.current.set(projectContextId, (observers.current.get(projectContextId) ?? 1) - 1)
      stopIfIdle(projectContextId)
    }
  }, [loadBranch, stopIfIdle])

  const dismissIngestion = useCallback(
    async (projectContextId: string, workflowId: string): WriteResult => {
      try {
        await dismissSourceIngestion(projectContextId, workflowId)
        const current = ingestionsRef.current[projectContextId]
        if (current)
          setProjectIngestions(projectContextId, {
            ...current, ingestions: current.ingestions.filter((row) => row.workflowId !== workflowId),
          })
        pollers.current.get(projectContextId)?.readNow()
        return null
      } catch (error) {
        return failure(error)
      }
    },
    [setProjectIngestions],
  )

  const addSources = useCallback<ProjectContextsValue['addSources']>(
    (sources) =>
      sendIngestion({
        type: 'sources.added',
        items: sources.map((source) => ({
          ...source,
          layout: source.layout ?? 'pages',
          itemId: crypto.randomUUID(),
          validationFailure:
            sourceDocumentFilenameFailure(source.file.name) ?? undefined,
        })),
      }),
    [sendIngestion],
  )

  const reprocessSource = useCallback<ProjectContextsValue['reprocessSource']>(
    (source) => {
      sendIngestion({
        type: 'sources.added',
        items: [
          {
            ...source,
            kind: 'reprocess',
            itemId: crypto.randomUUID(),
            requestKey: crypto.randomUUID(),
          },
        ],
      })
    },
    [sendIngestion],
  )

  const retrySource = useCallback(
    (itemId: string) => sendIngestion({ type: 'source.retry', itemId }),
    [sendIngestion],
  )

  const deleteProject = useCallback(
    async (projectContextId: string): WriteResult => {
      try {
        await deleteProjectContext(projectContextId)
        generation.current += 1
        setProjects((current) =>
          current.filter(
            (project) => project.projectContextId !== projectContextId,
          ),
        )
        setBranch(projectContextId, null)
        // Drops local ownership only; admitted work was cancelled by the
        // server's deletion, and a late result is ignored.
        sendIngestion({ type: 'project.deleted', projectContextId })
        stopPolling(projectContextId)
        watched.current.delete(projectContextId)
        setProjectIngestions(projectContextId, null)
        return null
      } catch (error) {
        return failure(error)
      }
    },
    [sendIngestion, setBranch, setProjectIngestions, stopPolling],
  )

  const deleteSource = useCallback(
    async (projectContextId: string, sourceDocumentId: string): WriteResult => {
      try {
        await deleteSourceDocument(projectContextId, sourceDocumentId)
        generation.current += 1
        const branch = branchesRef.current[projectContextId]
        if (branch?.status === 'loading')
          branchGenerations.current[projectContextId] =
            (branchGenerations.current[projectContextId] ?? 0) + 1
        if (branch?.status === 'ready') {
          const sourceDocuments = branch.detail.sourceDocuments.filter(
            (document) => document.sourceDocumentId !== sourceDocumentId,
          )
          setBranch(projectContextId, {
            status: 'ready',
            detail: { ...branch.detail, sourceDocuments },
          })
          setProjects((current) =>
            withSourceDocumentCount(
              current,
              projectContextId,
              sourceDocuments.length,
            ),
          )
          // Deleting the last Source Document moves the persisted phase back
          // to 'ingest' — refresh the list so the stepper reflects it.
          if (sourceDocuments.length === 0) reloadList.current()
        }
        return null
      } catch (error) {
        return failure(error)
      }
    },
    [setBranch],
  )

  return (
    <ProjectContextsContext
      value={{
        projects,
        recentActivity,
        listState,
        branches,
        loadBranch,
        retryList,
        refreshProjects,
        createProject,
        renameProject,
        deleteProject,
        deleteSourceDocument: deleteSource,
        acknowledgeSourceDocument,
        ingestingSources: ingestion.context.items,
        ingestions,
        observeIngestions,
        dismissIngestion,
        reprocessSource,
        sourceRevisions,
        addSources,
        retrySource,
      }}
    >
      {children}
    </ProjectContextsContext>
  )
}
