import { createActorContext } from '@xstate/react'
import type { ReactNode } from 'react'
import { useCallback, useEffect } from 'react'
import AppFrame from './AppFrame'
import {
  browserNavigationDeps,
  navigationMachine,
  parseRoute,
  type NavigableRoute,
} from './projectNavigation'
import { useRailTree } from './useRailTree'

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
          initialRoute: parseRoute(location.pathname),
        },
      }}
    >
      {children}
    </Navigation.Provider>
  )
}

export function ProjectRoutes() {
  const actor = Navigation.useActorRef()
  const snapshot = Navigation.useSelector((state) => state)
  const { route, snapshot: openDocument, failure } = snapshot.context
  const navigate = useCallback(
    (nextRoute: NavigableRoute) => actor.send({ type: 'NAVIGATE', route: nextRoute }),
    [actor],
  )
  const tree = useRailTree(route, navigate)
  const routedBranch =
    route.kind === 'document' ? tree.branches[route.projectContextId] : undefined
  const opening =
    snapshot.matches('opening') ||
    (snapshot.matches('routing') &&
      route.kind === 'document' &&
      routedBranch?.status !== 'error')
  const onInitialResourceLoadFailure = useCallback(
    () => actor.send({ type: 'RESOURCE_FAILED' }),
    [actor],
  )

  useEffect(() => {
    if (route.kind !== 'document' || tree.routedDocumentContained === null) return
    actor.send({
      type: tree.routedDocumentContained
        ? 'DOCUMENT_CONTAINED'
        : 'DOCUMENT_NOT_CONTAINED',
    })
  }, [actor, route, tree.routedDocumentContained])

  useEffect(() => {
    const changed = () =>
      actor.send({
        type: 'ROUTE_CHANGED',
        route: parseRoute(location.pathname),
      })
    addEventListener('popstate', changed)
    return () => removeEventListener('popstate', changed)
  }, [actor])

  return (
    <AppFrame
      route={route}
      tree={tree}
      openDocument={openDocument}
      opening={opening}
      failure={failure}
      onNavigate={navigate}
      onRetry={() => actor.send({ type: 'RETRY' })}
      onInitialResourceLoadFailure={onInitialResourceLoadFailure}
    />
  )
}
