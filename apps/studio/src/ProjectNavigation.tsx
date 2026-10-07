import { createActorContext } from '@xstate/react'
import type { ReactNode } from 'react'
import { useCallback, useEffect } from 'react'
import AppFrame from './AppFrame'
import { ProjectContextsProvider } from './projectContexts/ProjectContextsProvider'
import {
  useProjectContexts,
  useProjectContextRouteState } from './projectContexts/useProjectContexts'
import {
  browserNavigationDeps,
  navigationMachine,
  parseRoute,
  type NavigableRoute,
} from './projectNavigation'
import { browserStudioPathname } from './studioUrl.js'

const Navigation = createActorContext(navigationMachine)

export function ProjectNavigationProvider({
  children,
}: {
  children: ReactNode
}) {
  return (
    <Navigation.Provider
      logic={navigationMachine}
      options={{
        input: {
          deps: browserNavigationDeps(),
          initialRoute: parseRoute(browserStudioPathname(), location.search),
        },
      }}
    >
      <ProjectContextsProvider>{children}</ProjectContextsProvider>
    </Navigation.Provider>
  )
}

export function ProjectRoutes() {
  const actor = Navigation.useActorRef()
  const snapshot = Navigation.useSelector((state) => state)
  const { route, snapshot: openDocument, failure } = snapshot.context
  const navigate = useCallback(
    (nextRoute: NavigableRoute) =>
      actor.send({ type: 'NAVIGATE', route: nextRoute }),
    [actor],
  )
  const { sourceRevisions } = useProjectContexts()
  const publishedRevision =
    route.kind === 'document' && !route.extractionId
      ? sourceRevisions[route.sourceDocumentId]
      : undefined
  useEffect(() => {
    if (publishedRevision) actor.send({ type: 'SOURCE_REPROCESSED' })
  }, [actor, publishedRevision],
  )
  const routedProjectContext = useProjectContextRouteState(route)
  const { branch: routedBranch, documentContained: routedDocumentContained } =
    routedProjectContext
  const opening =
    snapshot.matches('opening') ||
    (snapshot.matches('routing') &&
      route.kind === 'document' &&
      routedBranch?.status !== 'error')
  const onInitialResourceLoadFailure = useCallback(
    () => actor.send({ type: 'RESOURCE_FAILED' }),
    [actor],
  )
  const onRefreshDocument = useCallback(
    () => actor.send({ type: 'REFRESH' }),
    [actor],
  )

  useEffect(() => {
    if (route.kind !== 'document' || routedDocumentContained === null) return
    actor.send({
      type: routedDocumentContained
        ? 'DOCUMENT_CONTAINED'
        : 'DOCUMENT_NOT_CONTAINED',
    })
  }, [actor, route, routedDocumentContained])

  useEffect(() => {
    const changed = () =>
      actor.send({
        type: 'ROUTE_CHANGED',
        route: parseRoute(browserStudioPathname(), location.search),
      })
    addEventListener('popstate', changed)
    return () => removeEventListener('popstate', changed)
  }, [actor])

  return (
    <AppFrame
      route={route}
      routedProjectContext={routedProjectContext}
      openDocument={openDocument}
      opening={opening}
      failure={failure}
      onNavigate={navigate}
      onRetry={() => actor.send({ type: 'RETRY' })}
      onInitialResourceLoadFailure={onInitialResourceLoadFailure}
      onRefreshDocument={onRefreshDocument}
    />
  )
}
