import { createContext, useContext, useEffect } from 'react'
import type { Route } from '../projectNavigation'
import type {
  ProjectContext,
  ProjectContextDetail,
  ProjectContextFailure,
} from './transport'

export type ProjectBranch =
  | { status: 'loading' }
  | { status: 'error'; failure: ProjectContextFailure }
  | { status: 'ready'; detail: ProjectContextDetail }

/** The routed branch, stripped of Source Document detail the shell never needs. */
export type ProjectContextRouteBranch =
  | { status: 'loading' }
  | { status: 'error'; failure: ProjectContextFailure }
  | { status: 'ready' }

/** The only routed state the surrounding shell needs from this feature. */
export type ProjectContextRouteState = {
  branch: ProjectContextRouteBranch | undefined
  documentContained: boolean | null
}

/** A write answers `null` when the rail already shows its acknowledged result. */
export type WriteResult = Promise<ProjectContextFailure | null>

export type ProjectContextsValue = {
  projects: ProjectContext[]
  listState:
    | { status: 'loading' | 'ready' }
    | { status: 'error'; failure: ProjectContextFailure }
  branches: Readonly<Record<string, ProjectBranch>>
  loadBranch: (projectContextId: string, retry?: boolean) => void
  retryList: () => void
  /** Resolves to the acknowledged summary so the caller can navigate to it. */
  createProject: (
    name: string,
  ) => Promise<
    | { created: ProjectContext; failure?: undefined }
    | { created?: undefined; failure: ProjectContextFailure }
  >
  renameProject: (projectContextId: string, name: string) => WriteResult
  /** Deletion never navigates; the caller routes away from a deleted selection. */
  deleteProject: (projectContextId: string) => WriteResult
}

export const ProjectContextsContext =
  createContext<ProjectContextsValue | null>(null)

export function useProjectContexts(): ProjectContextsValue {
  const value = useContext(ProjectContextsContext)
  if (!value)
    throw new Error('useProjectContexts requires a ProjectContextsProvider.')
  return value
}

/**
 * Keeps the routed branch read and narrows it for the shell. Callers receive
 * only what the workspace needs to render, never the branch cache itself.
 */
export function useProjectContextRouteState(
  route: Route,
): ProjectContextRouteState {
  const { branches, loadBranch } = useProjectContexts()
  const routedProjectContextId =
    route.kind === 'project' || route.kind === 'document'
      ? route.projectContextId
      : null
  const loadedBranch = routedProjectContextId
    ? branches[routedProjectContextId]
    : undefined
  const branch: ProjectContextRouteBranch | undefined =
    loadedBranch?.status === 'error'
      ? loadedBranch
      : loadedBranch
        ? { status: loadedBranch.status }
        : undefined
  const documentContained =
    route.kind === 'document' && loadedBranch?.status === 'ready'
      ? loadedBranch.detail.sourceDocuments.some(
          (document) => document.sourceDocumentId === route.sourceDocumentId,
        )
      : null

  useEffect(() => {
    if (routedProjectContextId) loadBranch(routedProjectContextId)
  }, [loadBranch, routedProjectContextId])

  return { branch, documentContained }
}
