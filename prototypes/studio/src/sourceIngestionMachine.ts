import { assign, fromPromise, setup } from 'xstate'
import type { SourceDocumentIngestionResponse } from '../shared/sourceDocumentIngestion.contract'

type AddedSource = {
  projectContextId: string
  file: File
  ingestionKey: string
  validationFailure?: string
}

export type SourceIngestionItem = AddedSource & {
  status: 'queued' | 'parsing' | 'failed'
  failure?: string
}

type Ingest = (item: SourceIngestionItem) => Promise<SourceDocumentIngestionResponse>
type Ingested = {
  item: SourceIngestionItem
  result: SourceDocumentIngestionResponse
}

export const sourceIngestionMachine = setup({
  types: {
    context: {} as {
      items: SourceIngestionItem[]
      ingest: Ingest
      onIngested: (ingested: Ingested) => void
      toFailureMessage: (error: unknown) => string
    },
    events: {} as
      | { type: 'sources.added'; items: AddedSource[] }
      | { type: 'source.retry'; ingestionKey: string }
      | { type: 'project.deleted'; projectContextId: string },
    input: {} as {
      ingest: Ingest
      onIngested: (ingested: Ingested) => void
      toFailureMessage: (error: unknown) => string
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
              item.ingestionKey === event.ingestionKey
                ? { ...item, status: 'queued' as const, failure: undefined }
                : item,
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
          item.ingestionKey === event.ingestionKey &&
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
                (item) => item.ingestionKey === event.output.item.ingestionKey,
              ),
            target: 'idle',
            actions: [
              // Dropping the in-flight entry and acknowledging the persisted
              // Source Document in one transition: the card is replaced by the
              // document it became, with no duplicate and no gap.
              assign({
                items: ({ context, event }) =>
                  context.items.filter(
                    (item) =>
                      item.ingestionKey !== event.output.item.ingestionKey,
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
                    item.ingestionKey === current.ingestionKey
                      ? {
                          ...item,
                          status: 'failed' as const,
                          failure: context.toFailureMessage(event.error),
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
