import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useMachine } from '@xstate/react'
import { sourceIngestionMachine } from '../sourceIngestionMachine'
import {
  createProjectContext,
  deleteProjectContext,
  deleteSourceDocument,
  getProjectContextWithDocuments,
  ingestSourceDocument,
  reprocessSourceDocument,
  listProjectContexts,
  renameProjectContext,
  provisionalSummary,
  toProjectContextFailure as failure,
  type ProjectContext,
  type ProjectContextActivityEvent,
} from './transport'
import {
  ProjectContextsContext,
  type ProjectBranch,
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

  const loadBranch = useCallback((projectContextId: string, retry = false) => {
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
    branchesRef.current = {
      ...branchesRef.current,
      [projectContextId]: { status: 'loading' },
    }
    setBranches(branchesRef.current)
    void getProjectContextWithDocuments(projectContextId).then(
      (detail) => {
        if (superseded()) return
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
      loadBranch(projectContextId, true)
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
      if (branch?.status === 'loading')
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
    },
    [setBranch],
  )

  // The ingestion queue lives here, not in a page: it must keep running while
  // the researcher navigates between Source Documents and Project Contexts.
  const [ingestion, sendIngestion] = useMachine(sourceIngestionMachine, {
    input: {
      ingest: (source) =>
        // The server owns ingestion once POSTed; actor shutdown only ignores
        // its result.
        source.kind === 'reprocess'
          ? reprocessSourceDocument(
              source.projectContextId,
              source.sourceDocumentId,
              {
                requestKey: source.ingestionKey,
                expectedRepresentationId: source.expectedRepresentationId,
                layout: source.layout,
              },
            )
          : ingestSourceDocument(
          source.projectContextId,
          source.file,
          source.ingestionKey,
          source.layout,
        ),
      toFailureMessage: (error) => failure(error).message,
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

  const addSources = useCallback<ProjectContextsValue['addSources']>(
    (sources) =>
      sendIngestion({
        type: 'sources.added',
        items: sources.map((source) => ({
          ...source,
          layout: source.layout ?? 'pages',
          ingestionKey: crypto.randomUUID(),
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
          { ...source, kind: 'reprocess', ingestionKey: crypto.randomUUID() },
        ],
      })
    },
    [sendIngestion],
  )

  const retrySource = useCallback(
    (ingestionKey: string) =>
      sendIngestion({ type: 'source.retry', ingestionKey }),
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
        // Drops local ownership only; an already-POSTed ingestion still
        // finishes on the server and its late result is ignored.
        sendIngestion({ type: 'project.deleted', projectContextId })
        return null
      } catch (error) {
        return failure(error)
      }
    },
    [sendIngestion, setBranch],
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
        createProject,
        renameProject,
        deleteProject,
        deleteSourceDocument: deleteSource,
        acknowledgeSourceDocument,
        ingestingSources: ingestion.context.items,
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
