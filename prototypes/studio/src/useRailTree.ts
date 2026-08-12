import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { z } from 'zod'
import type {
  projectContextErrorSchema,
  projectContextSummarySchema,
  projectContextWithDocumentsResponseSchema,
} from '../shared/projectContext.contract'
import type { NavigableRoute, Route } from './projectNavigation'
import {
  createProjectContext,
  deleteProjectContext,
  getProjectContextWithDocuments,
  listProjectContexts,
  renameProjectContext,
  toFailure as failure,
} from './projectContexts'

type ProjectContext = z.output<typeof projectContextSummarySchema>
type ProjectContextDetail = z.output<
  typeof projectContextWithDocumentsResponseSchema
>
type Failure = z.output<typeof projectContextErrorSchema>
export type ProjectBranch =
  | { status: 'loading' }
  | { status: 'error'; failure: Failure }
  | { status: 'ready'; detail: ProjectContextDetail }

/** A write answers `null` when the rail already shows its acknowledged result. */
export type RailWriteResult = Promise<Failure | null>

export function useRailTree(
  route: Route,
  navigate: (route: NavigableRoute) => void,
) {
  const [projects, setProjects] = useState<ProjectContext[]>([])
  const [listState, setListState] = useState<
    { status: 'loading' | 'ready' } | { status: 'error'; failure: Failure }
  >({ status: 'loading' })
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [collapsedRouted, setCollapsedRouted] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const [branches, setBranches] = useState<
    Readonly<Record<string, ProjectBranch>>
  >({})
  const branchesRef = useRef(branches)
  // Every applied write bumps this. A read that started under an older
  // generation predates acknowledged truth, so its payload is never merged —
  // it would resurrect a deleted Project Context or an old name.
  const generation = useRef(0)
  const reloadBranch = useRef<(projectContextId: string) => void>(() => {})
  const reloadList = useRef<() => void>(() => {})

  const loadBranch = useCallback((projectContextId: string, retry = false) => {
    const branch = branchesRef.current[projectContextId]
    if (!retry && (branch?.status === 'loading' || branch?.status === 'ready'))
      return
    const startedAt = generation.current
    // A superseded read is dropped, then re-issued — unless the write that
    // superseded it was the deletion of this very Project Context.
    const superseded = () => {
      if (startedAt === generation.current) return false
      if (branchesRef.current[projectContextId])
        reloadBranch.current(projectContextId)
      return true
    }
    branchesRef.current = {
      ...branchesRef.current,
      [projectContextId]: { status: 'loading' },
    }
    setBranches(branchesRef.current)
    // Branch reads fill an id-keyed cache and intentionally outlive collapse.
    void getProjectContextWithDocuments(projectContextId).then(
      (detail) => {
        if (superseded()) return
        branchesRef.current = {
          ...branchesRef.current,
          [projectContextId]: { status: 'ready', detail },
        }
        setBranches(branchesRef.current)
        setProjects((current) =>
          current.some(
            (project) => project.projectContextId === projectContextId,
          )
            ? current
            : [...current, detail.projectContext],
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
    reloadBranch.current = (projectContextId) => loadBranch(projectContextId, true)
  }, [loadBranch])

  const readProjects = useCallback((controller: AbortController) => {
    const startedAt = generation.current
    void listProjectContexts(controller.signal).then(
      (recent) => {
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

  const routedProjectContextId =
    route.kind === 'project' || route.kind === 'document'
      ? route.projectContextId
      : null
  const routedBranch = routedProjectContextId
    ? branches[routedProjectContextId]
    : undefined
  const routedDocumentContained =
    route.kind === 'document' && routedBranch?.status === 'ready'
      ? routedBranch.detail.sourceDocuments.some(
          (document) => document.sourceDocumentId === route.sourceDocumentId,
        )
      : null
  useEffect(() => {
    if (routedProjectContextId) loadBranch(routedProjectContextId)
  }, [loadBranch, routedProjectContextId])

  const visibleExpanded = useMemo(() => {
    const visible = new Set(expanded)
    if (
      routedProjectContextId &&
      !collapsedRouted.has(routedProjectContextId)
    )
      visible.add(routedProjectContextId)
    return visible
  }, [collapsedRouted, expanded, routedProjectContextId])

  const toggle = useCallback(
    (projectContextId: string) => {
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
    },
    [loadBranch, routedProjectContextId, visibleExpanded],
  )

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
    async (name: string): RailWriteResult => {
      try {
        const created = await createProjectContext(name)
        generation.current += 1
        setProjects((current) => [created, ...current])
        // Routing to it expands it and reads its (empty) branch.
        navigate({
          kind: 'project',
          projectContextId: created.projectContextId,
        })
        return null
      } catch (error) {
        return failure(error)
      }
    },
    [navigate],
  )

  const renameProject = useCallback(
    async (projectContextId: string, name: string): RailWriteResult => {
      try {
        const renamed = await renameProjectContext(projectContextId, name)
        generation.current += 1
        setProjects((current) =>
          current.map((project) =>
            project.projectContextId === projectContextId ? renamed : project,
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

  const deleteProject = useCallback(
    async (projectContextId: string): RailWriteResult => {
      try {
        await deleteProjectContext(projectContextId)
        generation.current += 1
        setProjects((current) =>
          current.filter(
            (project) => project.projectContextId !== projectContextId,
          ),
        )
        setBranch(projectContextId, null)
        // Only the open Project Context loses its route; any other one keeps it.
        if (projectContextId === routedProjectContextId)
          navigate({ kind: 'root' })
        return null
      } catch (error) {
        return failure(error)
      }
    },
    [navigate, routedProjectContextId, setBranch],
  )

  return {
    projects,
    listState,
    expanded: visibleExpanded,
    branches,
    activeProjectContextId: routedProjectContextId,
    activeSourceDocumentId:
      route.kind === 'document' ? route.sourceDocumentId : null,
    routedDocumentContained,
    toggle,
    createProject,
    renameProject,
    deleteProject,
    retryList,
    retryBranch: (projectContextId: string) => loadBranch(projectContextId, true),
  }
}

export type RailTree = ReturnType<typeof useRailTree>
