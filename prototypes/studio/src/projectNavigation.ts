import { assign, fromPromise, setup } from 'xstate'
import type { z } from 'zod'
import {
  canonicalUuidSchema,
  type projectContextErrorSchema,
} from '../shared/projectContext.contract'
import {
  type DocumentSnapshot,
  getDocumentReopenSnapshot,
  toFailure,
} from './projectContexts'

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
export type DocumentRoute = Extract<Route, { kind: 'document' }>
type Failure = z.output<typeof projectContextErrorSchema>
const sourceArtifactUnavailable: Failure = {
  code: 'source_artifact_unavailable',
  message: 'The retained Source Document artifact is unavailable.',
}

type Deps = { push(route: NavigableRoute): void }
type Context = {
  deps: Deps
  route: Route
  /** The open Source Document's durable snapshot; it outlives the next opening. */
  snapshot: DocumentSnapshot | null
  failure: Failure | null
}
type Event =
  | { type: 'NAVIGATE'; route: NavigableRoute }
  | { type: 'ROUTE_CHANGED'; route: Route }
  | { type: 'RETRY' }
  | { type: 'RESOURCE_FAILED' }
  | { type: 'DOCUMENT_CONTAINED' }
  | { type: 'DOCUMENT_NOT_CONTAINED' }

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

/** Only `opening` reads, and `routing` holds document routes until containment. */
function assertDocumentRoute(route: Route): DocumentRoute {
  if (route.kind !== 'document')
    throw new Error('Opening a Source Document requires a document route.')
  return route
}

// @xstate/react stops the actor on React's StrictMode remount, then rehydrates
// the abandoned promise actor's snapshot as `active` again — so xstate's own
// late-rejection guard lets the abandoned read's AbortError reach the restarted
// machine. An abandoned read must never settle. The pending promise is built per
// call so nothing module-scoped keeps the abandoned actor's closure alive.
function settleUnlessAborted<T>(
  read: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return read.catch((error: unknown) =>
    signal.aborted ? new Promise<never>(() => {}) : Promise.reject(error),
  )
}

export const navigationMachine = setup({
  types: {
    context: {} as Context,
    events: {} as Event,
    input: {} as { deps: Deps; initialRoute: Route },
  },
  actors: {
    reopenDocument: fromPromise<
      DocumentSnapshot,
      { projectContextId: string; sourceDocumentId: string }
    >(({ input, signal }) =>
      settleUnlessAborted(
        getDocumentReopenSnapshot(
          input.projectContextId,
          input.sourceDocumentId,
          signal,
        ),
        signal,
      ),
    ),
  },
  actions: {
    setRoute: assign(({ event }) =>
      event.type === 'NAVIGATE' || event.type === 'ROUTE_CHANGED'
        ? { route: event.route }
        : {},
    ),
    pushRoute: ({ context, event }) => {
      if (event.type === 'NAVIGATE') context.deps.push(event.route)
    },
    closeDocument: assign({ snapshot: null, failure: null }),
    clearFailure: assign({ failure: null }),
    failResource: assign({
      snapshot: null,
      failure: sourceArtifactUnavailable,
    }),
  },
  guards: {
    isNotDocumentRoute: ({ context }) => context.route.kind !== 'document',
  },
}).createMachine({
  id: 'projectNavigation',
  context: ({ input }) => ({
    deps: input.deps,
    route: input.initialRoute,
    snapshot: null,
    failure: null,
  }),
  initial: 'routing',
  // Every route change re-enters `routing`, which stops a superseded read.
  on: {
    NAVIGATE: {
      target: '.routing',
      actions: [{ type: 'pushRoute' }, { type: 'setRoute' }],
    },
    ROUTE_CHANGED: { target: '.routing', actions: [{ type: 'setRoute' }] },
  },
  states: {
    routing: {
      always: {
        guard: 'isNotDocumentRoute',
        target: 'idle',
        actions: [{ type: 'closeDocument' }],
      },
      on: {
        DOCUMENT_CONTAINED: { target: 'opening' },
        DOCUMENT_NOT_CONTAINED: {
          target: 'idle',
          actions: [{ type: 'closeDocument' }],
        },
      },
    },
    idle: {},
    opening: {
      entry: [{ type: 'clearFailure' }],
      invoke: {
        src: 'reopenDocument',
        input: ({ context }) => {
          const { projectContextId, sourceDocumentId } = assertDocumentRoute(
            context.route,
          )
          return { projectContextId, sourceDocumentId }
        },
        // Inline so the done/error event payloads stay typed.
        onDone: {
          target: 'open',
          actions: [assign({ snapshot: ({ event }) => event.output })],
        },
        onError: {
          target: 'failed',
          actions: [
            assign({
              snapshot: null,
              failure: ({ event }) => toFailure(event.error),
            }),
          ],
        },
      },
    },
    open: {
      on: {
        RESOURCE_FAILED: { target: 'failed', actions: [{ type: 'failResource' }] },
      },
    },
    failed: { on: { RETRY: { target: 'opening' } } },
  },
})

export function browserNavigationDeps(): Deps {
  return { push: (route) => history.pushState(null, '', href(route)) }
}
