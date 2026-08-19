import { useCallback, useState } from 'react'

export type DocumentTab = {
  sourceDocumentId: string
  name: string
}

type ProjectTabs = {
  tabs: DocumentTab[]
  activeSourceDocumentId: string | null
  /** Most-recently-active Source Document ids first, active one included. */
  recents: string[]
}

const EMPTY_PROJECT_TABS: ProjectTabs = {
  tabs: [],
  activeSourceDocumentId: null,
  recents: [],
}

function activated(state: ProjectTabs, sourceDocumentId: string): ProjectTabs {
  return {
    ...state,
    activeSourceDocumentId: sourceDocumentId,
    recents: [
      sourceDocumentId,
      ...state.recents.filter((id) => id !== sourceDocumentId),
    ],
  }
}

/**
 * VS Code-style open-tab state for Source Documents, kept per Project
 * Context. This is UI-local state layered on top of routing, not part of
 * it: the routed Source Document (see `projectNavigation.ts`) stays the one
 * source of truth for which document is actually open and fetched, and only
 * one project's tabs are ever visible at a time.
 */
export function useOpenDocumentTabs() {
  const [byProject, setByProject] = useState<Record<string, ProjectTabs>>({})

  const update = useCallback(
    (
      projectContextId: string,
      updater: (state: ProjectTabs) => ProjectTabs,
    ) => {
      setByProject((current) => ({
        ...current,
        [projectContextId]: updater(
          current[projectContextId] ?? EMPTY_PROJECT_TABS,
        ),
      }))
    },
    [],
  )

  const tabsFor = useCallback(
    (projectContextId: string) =>
      byProject[projectContextId]?.tabs ?? EMPTY_PROJECT_TABS.tabs,
    [byProject],
  )

  const activeSourceDocumentIdFor = useCallback(
    (projectContextId: string) =>
      byProject[projectContextId]?.activeSourceDocumentId ?? null,
    [byProject],
  )

  /** Opens (or reactivates) `sourceDocumentId` as a tab. */
  const open = useCallback(
    (projectContextId: string, sourceDocumentId: string, name: string) => {
      update(projectContextId, (state) => {
        const existing = state.tabs.find(
          (tab) => tab.sourceDocumentId === sourceDocumentId,
        )
        const tabs = existing
          ? state.tabs
          : [...state.tabs, { sourceDocumentId, name }]
        return activated({ ...state, tabs }, sourceDocumentId)
      })
    },
    [update],
  )

  /** Activates an already-open tab. */
  const activate = useCallback(
    (projectContextId: string, sourceDocumentId: string) => {
      update(projectContextId, (state) => activated(state, sourceDocumentId))
    },
    [update],
  )

  /** Closes a tab, returning the Source Document id that should become
   * active in its place (`null` if none remain), computed synchronously so
   * the caller can navigate to it in the same action. */
  const close = useCallback(
    (projectContextId: string, sourceDocumentId: string) => {
      let nextActiveSourceDocumentId: string | null = null
      update(projectContextId, (state) => {
        const tabs = state.tabs.filter(
          (tab) => tab.sourceDocumentId !== sourceDocumentId,
        )
        const recents = state.recents.filter((id) => id !== sourceDocumentId)
        const activeSourceDocumentId =
          state.activeSourceDocumentId === sourceDocumentId
            ? (recents[0] ?? null)
            : state.activeSourceDocumentId
        nextActiveSourceDocumentId = activeSourceDocumentId
        return { tabs, recents, activeSourceDocumentId }
      })
      return nextActiveSourceDocumentId
    },
    [update],
  )

  return {
    tabsFor,
    activeSourceDocumentIdFor,
    open,
    activate,
    close,
  }
}

export type OpenDocumentTabs = ReturnType<typeof useOpenDocumentTabs>
