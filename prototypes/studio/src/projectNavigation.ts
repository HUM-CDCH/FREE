import { assign, setup } from 'xstate'
import { canonicalUuidSchema } from '../shared/projectContext.contract'

export type Route =
  | { kind: 'root' }
  | { kind: 'project'; projectContextId: string }
  | {
      kind: 'document'
      projectContextId: string
      sourceDocumentId: string
    }
  | { kind: 'badReference' }

export type NavigableRoute = Exclude<Route, { kind: 'badReference' }>

type Deps = { push(route: NavigableRoute): void }
type Context = { deps: Deps; route: Route }
type Event =
  | { type: 'NAVIGATE'; route: NavigableRoute }
  | { type: 'ROUTE_CHANGED'; route: Route }

export function parseRoute(pathname: string): Route {
  const path =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname
  if (path === '/projects') return { kind: 'root' }

  const project = /^\/projects\/([^/]+)(?:\/documents)?$/.exec(path)
  if (project) {
    const projectContextId = project[1]
    return canonicalUuidSchema.safeParse(projectContextId).success
      ? { kind: 'project', projectContextId }
      : { kind: 'badReference' }
  }

  const document =
    /^\/projects\/([^/]+)\/documents\/([^/]+)$/.exec(path)
  if (document) {
    const [, projectContextId, sourceDocumentId] = document
    return canonicalUuidSchema.safeParse(projectContextId).success &&
      canonicalUuidSchema.safeParse(sourceDocumentId).success
      ? { kind: 'document', projectContextId, sourceDocumentId }
      : { kind: 'badReference' }
  }

  return path.startsWith('/projects/')
    ? { kind: 'badReference' }
    : { kind: 'root' }
}

export function href(route: NavigableRoute): string {
  if (route.kind === 'root') return '/'
  const project = `/projects/${route.projectContextId}`
  return route.kind === 'project'
    ? project
    : `${project}/documents/${route.sourceDocumentId}`
}

export const navigationMachine = setup({
  types: {
    context: {} as Context,
    events: {} as Event,
    input: {} as { deps: Deps; initialRoute: Route },
  },
  actions: {
    setRoute: assign(({ event }) => ({ route: event.route })),
    pushRoute: ({ context, event }) => {
      if (event.type === 'NAVIGATE') context.deps.push(event.route)
    },
  },
}).createMachine({
  id: 'projectNavigation',
  context: ({ input }) => ({ deps: input.deps, route: input.initialRoute }),
  initial: 'idle',
  on: {
    NAVIGATE: { actions: [{ type: 'pushRoute' }, { type: 'setRoute' }] },
    ROUTE_CHANGED: { actions: [{ type: 'setRoute' }] },
  },
  states: { idle: {} },
})

export function browserNavigationDeps(): Deps {
  return { push: (route) => history.pushState(null, '', href(route)) }
}
