import { assign, fromPromise, setup } from 'xstate'
import type { SourceDocumentReprocessResponse } from '../shared/sourceDocumentReprocess.contract'

/** How the PDF's pages are read: single PDF pages, or scanned two-page spreads split into book pages. */
export type SourceLayout = 'pages' | 'spreads'

type AddedSource = {
  /** The queue's own identity for this item. It never leaves the browser: an upload is identified by its content. */
  itemId: string
  projectContextId: string
  layout: SourceLayout
  validationFailure?: string
} & (
  | { kind?: 'upload'; file: File }
  | {
      kind: 'reprocess'
      sourceDocumentId: string
      expectedRepresentationId: string
      name: string
      /** The server's replay key for this reprocess action (`reprocess:<document>:<key>`). */
      requestKey: string
    }
)

export function sourceName(source: SourceIngestionItem): string {
  return source.kind === 'reprocess' ? source.name : source.file.name
}

export type SourceIngestionItem = AddedSource & {
  status: 'queued' | 'parsing' | 'failed'
  failure?: string
  /** The last failure left the server's outcome unknown (a network error, 502, 503 or 504). */
  uncertain?: boolean
}

type Ingest = (item: SourceIngestionItem) => Promise<SourceDocumentReprocessResponse>
type Ingested = {
  item: SourceIngestionItem
  result: SourceDocumentReprocessResponse
}

/** A failed item queued again. A reprocess keeps its request key only after an uncertain failure, where repeating it
 *  replays whatever the server did; after a confirmed failure the retry is a new action with a new key. */
function retried(item: SourceIngestionItem): SourceIngestionItem {
  const queued = { ...item, status: 'queued' as const, failure: undefined, uncertain: undefined }
  return queued.kind === 'reprocess' && !item.uncertain
    ? { ...queued, requestKey: crypto.randomUUID() }
    : queued
}

export const sourceIngestionMachine = setup({
  types: {
    context: {} as {
      items: SourceIngestionItem[]
      ingest: Ingest
      onIngested: (ingested: Ingested) => void
      toFailureMessage: (error: unknown) => string
      isUncertain: (error: unknown) => boolean
    },
    events: {} as
      | { type: 'sources.added'; items: AddedSource[] }
      | { type: 'source.retry'; itemId: string }
      | { type: 'project.deleted'; projectContextId: string },
    input: {} as {
      ingest: Ingest
      onIngested: (ingested: Ingested) => void
      toFailureMessage: (error: unknown) => string
      isUncertain: (error: unknown) => boolean
    },
  },
  actors: {
    ingestCurrent: fromPromise<Ingested, { item: SourceIngestionItem; ingest: Ingest }>(
      async ({ input }) => ({
        item: input.item,
        result: await input.ingest(input.item),
      }),
    ),
  },
  actions: {
    addSources: assign({
      items: ({ context, event }) =>
        event.type === 'sources.added'
          ? [
              ...context.items,
              ...event.items.map((item) => ({
                ...item,
                status: item.validationFailure
                  ? ('failed' as const)
                  : ('queued' as const),
                ...(item.validationFailure
                  ? { failure: item.validationFailure }
                  : {}),
              })),
            ]
          : context.items,
    }),
    retrySource: assign({
      items: ({ context, event }) =>
        event.type === 'source.retry'
          ? context.items.map((item) =>
              item.itemId === event.itemId ? retried(item) : item,
            )
          : context.items,
    }),
    removeProject: assign({
      items: ({ context, event }) =>
        event.type === 'project.deleted'
          ? context.items.filter(
              (item) => item.projectContextId !== event.projectContextId,
            )
          : context.items,
    }),
    startNext: assign({
      items: ({ context }) => {
        const index = context.items.findIndex((item) => item.status === 'queued')
        return index < 0
          ? context.items
          : context.items.map((item, itemIndex) =>
              itemIndex === index
                ? { ...item, status: 'parsing' as const, failure: undefined }
                : item,
            )
      },
    }),
  },
  guards: {
    hasQueuedSource: ({ context }) =>
      context.items.some((item) => item.status === 'queued'),
    isFailedSource: ({ context, event }) =>
      event.type === 'source.retry' &&
      context.items.some(
        (item) =>
          item.itemId === event.itemId &&
          item.status === 'failed' &&
          item.validationFailure === undefined,
      ),
  },
}).createMachine({
  id: 'sourceIngestion',
  context: ({ input }) => ({ items: [], ...input }),
  initial: 'idle',
  on: {
    'sources.added': { actions: [{ type: 'addSources' }] },
    'source.retry': {
      guard: 'isFailedSource',
      actions: [{ type: 'retrySource' }],
    },
    // No target: remove local ownership without stopping the server-owned POST.
    'project.deleted': { actions: [{ type: 'removeProject' }] },
  },
  states: {
    idle: {
      always: {
        guard: 'hasQueuedSource',
        target: 'ingesting',
        actions: [{ type: 'startNext' }],
      },
    },
    ingesting: {
      invoke: {
        id: 'ingest',
        src: 'ingestCurrent',
        input: ({ context }) => ({
          item: context.items.find((item) => item.status === 'parsing')!,
          ingest: context.ingest,
        }),
        onDone: [
          {
            guard: ({ context, event }) =>
              context.items.some(
                (item) => item.itemId === event.output.item.itemId,
              ),
            target: 'idle',
            actions: [
              // Dropping the in-flight entry and acknowledging the persisted
              // Source Document in one transition: the card is replaced by the
              // document it became, with no duplicate and no gap.
              assign({
                items: ({ context, event }) =>
                  context.items.filter(
                    (item) => item.itemId !== event.output.item.itemId,
                  ),
              }),
              ({ context, event }) => context.onIngested(event.output),
            ],
          },
          { target: 'idle' },
        ],
        onError: [
          {
            guard: ({ context }) =>
              context.items.some((item) => item.status === 'parsing'),
            target: 'idle',
            actions: [
              assign({
                items: ({ context, event }) => {
                  const current = context.items.find(
                    (item) => item.status === 'parsing',
                  )
                  if (!current) return context.items
                  return context.items.map((item) =>
                    item.itemId === current.itemId
                      ? {
                          ...item,
                          status: 'failed' as const,
                          failure: context.toFailureMessage(event.error),
                          uncertain: context.isUncertain(event.error),
                        }
                      : item,
                  )
                },
              }),
            ],
          },
          { target: 'idle' },
        ],
      },
    },
  },
})
