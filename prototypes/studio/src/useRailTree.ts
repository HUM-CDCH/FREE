import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { z } from 'zod'
import {
  projectContextErrorSchema,
  type projectContextSummarySchema,
  type projectContextWithDocumentsResponseSchema,
} from '../shared/projectContext.contract'
import type { Route } from './projectNavigation'
import {
  getProjectContextWithDocuments,
  listProjectContexts,
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

function failure(error: unknown): Failure {
  const parsed = projectContextErrorSchema.safeParse(error)
  if (parsed.success) return parsed.data
  return {
    code: 'persistence_unavailable',
    message: 'Project Context storage is unavailable.',
  }
}

export function useRailTree(route: Route) {
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

  const loadBranch = useCallback((projectContextId: string, retry = false) => {
    const branch = branchesRef.current[projectContextId]
    if (branch?.status === 'loading' || (!retry && branch?.status === 'ready'))
      return
    branchesRef.current = {
      ...branchesRef.current,
      [projectContextId]: { status: 'loading' },
    }
    setBranches(branchesRef.current)
    // Branch reads fill an id-keyed cache and intentionally outlive collapse.
    void getProjectContextWithDocuments(projectContextId).then(
      (detail) => {
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
        branchesRef.current = {
          ...branchesRef.current,
          [projectContextId]: { status: 'error', failure: failure(error) },
        }
        setBranches(branchesRef.current)
      },
    )
  }, [])

  const readProjects = useCallback((controller: AbortController) => {
    void listProjectContexts(controller.signal).then(
      (recent) => {
        if (controller.signal.aborted) return
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
        if (!controller.signal.aborted)
          setListState({ status: 'error', failure: failure(error) })
      },
    )
  }, [])

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

  return {
    projects,
    listState,
    expanded: visibleExpanded,
    branches,
    activeProjectContextId: routedProjectContextId,
    activeSourceDocumentId:
      route.kind === 'document' ? route.sourceDocumentId : null,
    toggle,
    retryList,
    retryBranch: (projectContextId: string) => loadBranch(projectContextId, true),
  }
}

export type RailTree = ReturnType<typeof useRailTree>
