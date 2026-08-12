import { createActorContext } from '@xstate/react'
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import AppFrame from './AppFrame'
import {
  browserNavigationDeps,
  navigationMachine,
  parseRoute,
} from './projectNavigation'

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
  const route = Navigation.useSelector((snapshot) => snapshot.context.route)

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
      onNavigate={(nextRoute) =>
        actor.send({ type: 'NAVIGATE', route: nextRoute })
      }
    />
  )
}
