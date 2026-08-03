import { assign, fromPromise, setup } from 'xstate'
import type { z } from 'zod'
import {
  projectContextChooserResponseSchema,
  projectContextErrorResponseSchema,
  projectContextErrorSchema,
  projectContextListResponseSchema,
  projectContextSummarySchema,
} from '../shared/projectContext.contract'

type Deps = {
  list(
    signal: AbortSignal,
  ): Promise<Array<z.output<typeof projectContextSummarySchema>>>
  chooser(
    projectContextId: string,
    signal: AbortSignal,
  ): Promise<z.output<typeof projectContextChooserResponseSchema>>
  push(projectContextId: string | null): void
}
type Context = {
  deps: Deps
  projects: Array<z.output<typeof projectContextSummarySchema>>
  projectContextId: string | null
  chooser: z.output<typeof projectContextChooserResponseSchema> | null
  failure: z.output<typeof projectContextErrorSchema> | null
}
type Event =
  | { type: 'OPEN_PROJECT'; projectContextId: string }
  | { type: 'GO_PROJECT_LIST' }
  | { type: 'URL_CHANGED'; projectContextId: string | null }
  | { type: 'RETRY' }

function failure(error: unknown): z.output<typeof projectContextErrorSchema> {
  const parsed = projectContextErrorSchema.safeParse(error)
  if (parsed.success) return parsed.data
  // Unrecognised failures all read as "storage is unavailable" in the UI, so keep
  // the real cause (transport, cancellation, contract mismatch) diagnosable.
  console.error('Unrecognised Project Context failure', error)
  return {
    code: 'persistence_unavailable',
    message: 'Project Context storage is unavailable.',
  }
}

// @xstate/react stops the actor on React's StrictMode remount, then rehydrates
// the abandoned promise actor's snapshot as `active` again — so xstate's own
// late-rejection guard lets the abandoned read's AbortError reach the restarted
// machine. An abandoned read must never settle.
const abandoned = new Promise<never>(() => {})
function settleUnlessAborted<T>(
  read: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return read.catch((error: unknown) =>
    signal.aborted ? abandoned : Promise.reject(error),
  )
}

export const navigationMachine = setup({
  types: {
    context: {} as Context,
    events: {} as Event,
    input: {} as { deps: Deps; initialProjectContextId: string | null },
  },
  actors: {
    list: fromPromise(
      ({ input, signal }: { input: Deps; signal: AbortSignal }) =>
        settleUnlessAborted(input.list(signal), signal),
    ),
    chooser: fromPromise(
      ({
        input,
        signal,
      }: {
        input: { deps: Deps; projectContextId: string }
        signal: AbortSignal
      }) =>
        settleUnlessAborted(
          input.deps.chooser(input.projectContextId, signal),
          signal,
        ),
    ),
  },
  guards: {
    hasRoute: ({ context }) => context.projectContextId !== null,
    eventHasRoute: ({ event }) =>
      event.type === 'URL_CHANGED' && event.projectContextId !== null,
  },
  actions: {
    setRoute: assign(({ event }) => ({
      projectContextId:
        event.type === 'OPEN_PROJECT' || event.type === 'URL_CHANGED'
          ? event.projectContextId
          : null,
      chooser: null,
      failure: null,
    })),
    pushProject: ({ context, event }) => {
      if (event.type === 'OPEN_PROJECT')
        context.deps.push(event.projectContextId)
    },
    pushList: ({ context }) => context.deps.push(null),
  },
}).createMachine({
  id: 'projectNavigation',
  context: ({ input }) => ({
    deps: input.deps,
    projects: [],
    projectContextId: input.initialProjectContextId,
    chooser: null,
    failure: null,
  }),
  initial: 'loadingList',
  on: {
    OPEN_PROJECT: {
      target: '.loadingChooser',
      actions: [{ type: 'setRoute' }, { type: 'pushProject' }],
    },
    GO_PROJECT_LIST: {
      target: '.projectList',
      actions: [{ type: 'setRoute' }, { type: 'pushList' }],
    },
    URL_CHANGED: [
      {
        guard: { type: 'eventHasRoute' },
        target: '.loadingChooser',
        actions: [{ type: 'setRoute' }],
      },
      { target: '.projectList', actions: [{ type: 'setRoute' }] },
    ],
  },
  states: {
    loadingList: {
      entry: assign({ failure: null }),
      invoke: {
        src: 'list',
        input: ({ context }) => context.deps,
        onDone: {
          target: 'afterList',
          actions: assign({ projects: ({ event }) => event.output }),
        },
        onError: {
          target: 'listError',
          actions: assign({ failure: ({ event }) => failure(event.error) }),
        },
      },
    },
    afterList: {
      always: [
        { guard: { type: 'hasRoute' }, target: 'loadingChooser' },
        { target: 'projectList' },
      ],
    },
    projectList: {},
    loadingChooser: {
      entry: assign({ chooser: null, failure: null }),
      invoke: {
        src: 'chooser',
        input: ({ context }) => ({
          deps: context.deps,
          projectContextId: context.projectContextId!,
        }),
        onDone: {
          target: 'choosingDocument',
          actions: assign({ chooser: ({ event }) => event.output }),
        },
        onError: {
          target: 'chooserError',
          actions: assign({ failure: ({ event }) => failure(event.error) }),
        },
      },
    },
    choosingDocument: {},
    listError: { on: { RETRY: 'loadingList' } },
    chooserError: { on: { RETRY: 'loadingChooser' } },
  },
})

async function request<T>(
  url: string,
  schema: { parse(value: unknown): T },
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(url, { signal })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = projectContextErrorResponseSchema.safeParse(body)
    if (error.success) throw error.data.error
    throw new Error('Project Context request failed.')
  }
  return schema.parse(body)
}

export function browserNavigationDeps(): Deps {
  return {
    list: async (signal) =>
      (
        await request(
          '/api/project-contexts',
          projectContextListResponseSchema,
          signal,
        )
      ).projectContexts,
    chooser: (id, signal) =>
      request(
        `/api/project-contexts/${id}`,
        projectContextChooserResponseSchema,
        signal,
      ),
    push: (id) => history.pushState(null, '', id ? `/projects/${id}` : '/'),
  }
}

export function projectContextIdFromLocation(
  pathname = location.pathname,
): string | null {
  return /^\/projects\/([^/]+)$/.exec(pathname)?.[1] ?? null
}
