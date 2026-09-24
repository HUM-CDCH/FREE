import { assign, fromPromise, setup } from 'xstate'
import type { z } from 'zod'
import {
  canonicalUuidSchema,
  type projectContextErrorSchema,
} from '../shared/projectContext.contract'
import {
  type DocumentSnapshot,
  getDocumentReopenSnapshot,
  toProjectContextFailure,
} from './projectContexts/transport'
import { browserStudioPath } from './studioUrl.js'

/**
 * The Project Context page's routed view: which resource tab is open, and —
 * because only Extractions has one — the opened Batch Extraction.
 */
export type ProjectResource =
  | { tab: 'sources' }
  | { tab: 'schemas' }
  | { tab: 'extractions'; batchExtractionId?: string; view?: 'grid' }

export type ProjectRoute = {
  kind: 'project'
  projectContextId: string
} & ProjectResource

export type Route =
  | { kind: 'root' }
  | ProjectRoute
  | {
      kind: 'document'
      projectContextId: string
      sourceDocumentId: string
      extractionId?: string
      /** The Batch Extraction whose review grid opened this document, so the
       *  document view can offer a direct way back to it. Pure navigation
       *  metadata — never affects which document snapshot is fetched. */
      fromBatchExtractionId?: string
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
  | { type: 'SOURCE_REPROCESSED' }
  | { type: 'RESOURCE_FAILED' }
  | { type: 'DOCUMENT_CONTAINED' }
  | { type: 'DOCUMENT_NOT_CONTAINED' }

export function parseRoute(pathname: string, search = ''): Route {
  const [pathOnly, inlineSearch = ''] = pathname.split('?', 2)
  const path =
    pathOnly.length > 1 && pathOnly.endsWith('/')
      ? pathOnly.slice(0, -1)
      : pathOnly
  if (path === '/projects') return { kind: 'root' }

  // Sources keeps the bare Project Context path; `/documents` is its alias, so
  // truncating a Source Document's URL lands on the list that contains it.
  const project = /^\/projects\/([^/]+)(?:\/(documents|schemas))?$/.exec(path)
  if (project) {
    const [, projectContextId, segment] = project
    return canonicalUuidSchema.safeParse(projectContextId).success
      ? {
          kind: 'project',
          projectContextId,
          tab: segment === 'schemas' ? 'schemas' : 'sources',
        }
      : { kind: 'badReference' }
  }

  // The batch review grid is a distinct screen over one Batch Extraction, so
  // it needs its own path shape ahead of the bare extractions match below.
  const batchReview =
    /^\/projects\/([^/]+)\/extractions\/([^/]+)\/review$/.exec(path)
  if (batchReview) {
    const [, projectContextId, batchExtractionId] = batchReview
    return canonicalUuidSchema.safeParse(projectContextId).success &&
      canonicalUuidSchema.safeParse(batchExtractionId).success
      ? { kind: 'project', projectContextId, tab: 'extractions', batchExtractionId, view: 'grid' }
      : { kind: 'badReference' }
  }

  // Extractions is the one tab with a resource of its own beneath it.
  const extractions = /^\/projects\/([^/]+)\/extractions(?:\/([^/]+))?$/.exec(
    path,
  )
  if (extractions) {
    const [, projectContextId, batchExtractionId] = extractions
    return canonicalUuidSchema.safeParse(projectContextId).success &&
      (batchExtractionId === undefined ||
        canonicalUuidSchema.safeParse(batchExtractionId).success)
      ? {
          kind: 'project',
          projectContextId,
          tab: 'extractions',
          ...(batchExtractionId ? { batchExtractionId } : {}),
        }
      : { kind: 'badReference' }
  }

  const document =
    /^\/projects\/([^/]+)\/documents\/([^/]+)$/.exec(path)
  if (document) {
    const [, projectContextId, sourceDocumentId] = document
    const params = new URLSearchParams(search || inlineSearch)
    const extractionId = params.get('extractionId')
    const fromBatchExtractionId = params.get('fromBatchExtractionId')
    return canonicalUuidSchema.safeParse(projectContextId).success &&
      canonicalUuidSchema.safeParse(sourceDocumentId).success &&
      (extractionId === null || canonicalUuidSchema.safeParse(extractionId).success) &&
      (fromBatchExtractionId === null ||
        canonicalUuidSchema.safeParse(fromBatchExtractionId).success)
      ? {
          kind: 'document',
          projectContextId,
          sourceDocumentId,
          ...(extractionId ? { extractionId } : {}),
          ...(fromBatchExtractionId ? { fromBatchExtractionId } : {}),
        }
      : { kind: 'badReference' }
  }

  return path.startsWith('/projects/')
    ? { kind: 'badReference' }
    : { kind: 'root' }
}

export function href(route: NavigableRoute): string {
  if (route.kind === 'root') return '/projects'
  const project = `/projects/${route.projectContextId}`
  if (route.kind === 'document') {
    const params = new URLSearchParams({
      ...(route.extractionId ? { extractionId: route.extractionId } : {}),
      ...(route.fromBatchExtractionId
        ? { fromBatchExtractionId: route.fromBatchExtractionId }
        : {}),
    })
    return `${project}/documents/${route.sourceDocumentId}${params.size ? `?${params}` : ''}`
  }
  if (route.tab === 'sources') return project
  if (route.tab === 'schemas') return `${project}/schemas`
  return `${project}/extractions${
    route.batchExtractionId ? `/${route.batchExtractionId}` : ''
  }${route.batchExtractionId && route.view === 'grid' ? '/review' : ''}`
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
      { projectContextId: string; sourceDocumentId: string; extractionId?: string }
    >(({ input, signal }) =>
      settleUnlessAborted(
        getDocumentReopenSnapshot(
          input.projectContextId,
          input.sourceDocumentId,
          signal,
          input.extractionId,
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
    SOURCE_REPROCESSED: {
      guard: ({ context }) =>
        context.route.kind === 'document' && !context.route.extractionId,
      target: '.opening',
    },
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
          const { projectContextId, sourceDocumentId, extractionId } = assertDocumentRoute(
            context.route,
          )
          return { projectContextId, sourceDocumentId, extractionId }
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
              failure: ({ event }) => toProjectContextFailure(event.error),
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
  return {
    push: (route) =>
      history.pushState(null, '', browserStudioPath(href(route))),
  }
}
