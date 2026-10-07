import { assign, fromPromise, setup } from 'xstate'
import type { SourceDocumentIngestionResponse } from '../shared/sourceDocumentIngestion.contract'
import type { SourceDocumentReprocessResponse } from '../shared/sourceDocumentReprocess.contract'
import type { UploadAdmission } from './projectContexts/transport'

/** How the PDF's pages are read: single PDF pages, or scanned two-page spreads split into book pages. */
export type SourceLayout = 'pages' | 'spreads'

type UploadSource = {
  /** The queue's own identity for this item. It never leaves the browser: an upload is identified by its content. */
  itemId: string
  projectContextId: string
  layout: SourceLayout
  validationFailure?: string
  kind?: 'upload'
  file: File
}
type ReprocessSource = {
  itemId: string
  projectContextId: string
  layout: SourceLayout
  validationFailure?: string
  kind: 'reprocess'
  sourceDocumentId: string
  expectedRepresentationId: string
  name: string
  /** The server's replay key for this reprocess action (`reprocess:<document>:<key>`). */
  requestKey: string
}
type AddedSource = UploadSource | ReprocessSource

type Outcome = {
  failure?: string
  /** The last failure left the server's outcome unknown (a network error, 502, 503 or 504). */
  uncertain?: boolean
}
/**
 * An upload is held only until Studio admits it: `waiting` and `sending` while its bytes go, `admitted` (with the
 * workflow it became) until the Source Ingestion listing shows that workflow, or `failed` when it could not be sent.
 */
export type UploadItem = UploadSource & Outcome & {
  status: 'waiting' | 'sending' | 'admitted' | 'failed'
  workflowId?: string
}
/** A reprocess still waits on its parse (Part B moves it to admission too). */
export type ReprocessItem = ReprocessSource & Outcome & { status: 'queued' | 'parsing' | 'failed' }
export type SourceIngestionItem = UploadItem | ReprocessItem

export function sourceName(source: SourceIngestionItem): string {
  return source.kind === 'reprocess' ? source.name : source.file.name
}

type Ingest = (item: SourceIngestionItem) => Promise<UploadAdmission>
type Reprocess = (item: SourceIngestionItem) => Promise<SourceDocumentReprocessResponse>
type Reprocessed = { item: SourceIngestionItem; result: SourceDocumentReprocessResponse }
type Sent = { item: SourceIngestionItem; admission: UploadAdmission }

const isUpload = (item: SourceIngestionItem): item is UploadItem => item.kind !== 'reprocess'
const isReprocess = (item: SourceIngestionItem): item is ReprocessItem => item.kind === 'reprocess'

/** A failed reprocess queued again. It keeps its request key only after an uncertain failure, where repeating it
 *  replays whatever the server did; after a confirmed failure the retry is a new action with a new key. */
function retried(item: ReprocessItem): ReprocessItem {
  const queued = { ...item, status: 'queued' as const, failure: undefined, uncertain: undefined }
  return item.uncertain ? queued : { ...queued, requestKey: crypto.randomUUID() }
}

export const sourceIngestionMachine = setup({
  types: {
    context: {} as {
      items: SourceIngestionItem[]
      ingest: Ingest
      reprocess: Reprocess
      onAdmitted: (item: SourceIngestionItem, workflowId: string) => void
      onReplayed: (item: SourceIngestionItem, document: SourceDocumentIngestionResponse) => void
      onIngested: (reprocessed: Reprocessed) => void
      toFailureMessage: (error: unknown) => string
      isUncertain: (error: unknown) => boolean
    },
    events: {} as
      | { type: 'sources.added'; items: AddedSource[] }
      | { type: 'source.retry'; itemId: string }
      | { type: 'project.deleted'; projectContextId: string }
      | { type: 'ingestions.observed'; projectContextId: string; workflowIds: readonly string[]; absent: readonly string[] },
    input: {} as {
      ingest: Ingest
      reprocess: Reprocess
      onAdmitted: (item: SourceIngestionItem, workflowId: string) => void
      onReplayed: (item: SourceIngestionItem, document: SourceDocumentIngestionResponse) => void
      onIngested: (reprocessed: Reprocessed) => void
      toFailureMessage: (error: unknown) => string
      isUncertain: (error: unknown) => boolean
    },
  },
  actors: {
    sendUpload: fromPromise<Sent, { item: SourceIngestionItem; ingest: Ingest }>(
      async ({ input }) => ({ item: input.item, admission: await input.ingest(input.item) }),
    ),
    reprocessCurrent: fromPromise<Reprocessed, { item: SourceIngestionItem; reprocess: Reprocess }>(
      async ({ input }) => ({ item: input.item, result: await input.reprocess(input.item) }),
    ),
  },
  actions: {
    addSources: assign({
      items: ({ context, event }) =>
        event.type === 'sources.added'
          ? [
              ...context.items,
              ...event.items.map((item): SourceIngestionItem => {
                const failed = item.validationFailure ? { status: 'failed' as const, failure: item.validationFailure } : null
                return item.kind === 'reprocess'
                  ? { ...item, ...(failed ?? { status: 'queued' as const }) }
                  : { ...item, ...(failed ?? { status: 'waiting' as const }) }
              }),
            ]
          : context.items,
    }),
    retrySource: assign({
      items: ({ context, event }) =>
        event.type === 'source.retry'
          ? context.items.map((item) => {
              if (item.itemId !== event.itemId) return item
              return isReprocess(item)
                ? retried(item)
                : { ...item, status: 'waiting' as const, failure: undefined, uncertain: undefined }
            })
          : context.items,
    }),
    removeProject: assign({
      items: ({ context, event }) =>
        event.type === 'project.deleted'
          ? context.items.filter((item) => item.projectContextId !== event.projectContextId)
          : context.items,
    }),
    // Identity, not names: an admitted upload leaves once Studio lists its workflow or says it holds none by that ID.
    dropObserved: assign({
      items: ({ context, event }) =>
        event.type === 'ingestions.observed'
          ? context.items.filter((item) =>
              !(isUpload(item) && item.status === 'admitted' && item.projectContextId === event.projectContextId &&
                (event.workflowIds.includes(item.workflowId!) || event.absent.includes(item.workflowId!))))
          : context.items,
    }),
    startNextUpload: assign({
      items: ({ context }) => {
        const next = context.items.find((item) => isUpload(item) && item.status === 'waiting')
        return context.items.map((item) =>
          item === next ? { ...item, status: 'sending' as const, failure: undefined } as UploadItem : item)
      },
    }),
    startNextReprocess: assign({
      items: ({ context }) => {
        const next = context.items.find((item) => isReprocess(item) && item.status === 'queued')
        return context.items.map((item) =>
          item === next ? { ...item, status: 'parsing' as const, failure: undefined } as ReprocessItem : item)
      },
    }),
  },
  guards: {
    hasWaitingUpload: ({ context }) => context.items.some((item) => isUpload(item) && item.status === 'waiting'),
    hasQueuedReprocess: ({ context }) => context.items.some((item) => isReprocess(item) && item.status === 'queued'),
    isFailedSource: ({ context, event }) =>
      event.type === 'source.retry' &&
      context.items.some((item) => item.itemId === event.itemId && item.status === 'failed' && item.validationFailure === undefined),
  },
}).createMachine({
  id: 'sourceIngestion',
  type: 'parallel',
  context: ({ input }) => ({ items: [], ...input }),
  on: {
    'sources.added': { actions: [{ type: 'addSources' }] },
    'source.retry': { guard: 'isFailedSource', actions: [{ type: 'retrySource' }] },
    // Removes local ownership without stopping the server-owned work.
    'project.deleted': { actions: [{ type: 'removeProject' }] },
    'ingestions.observed': { actions: [{ type: 'dropObserved' }] },
  },
  states: {
    uploads: {
      initial: 'idle',
      states: {
        idle: {
          always: { guard: 'hasWaitingUpload', target: 'sending', actions: [{ type: 'startNextUpload' }] },
        },
        sending: {
          invoke: {
            src: 'sendUpload',
            input: ({ context }) => ({
              item: context.items.find((item) => isUpload(item) && item.status === 'sending')!,
              ingest: context.ingest,
            }),
            onDone: [
              {
                guard: ({ context, event }) => context.items.some((item) => item.itemId === event.output.item.itemId),
                target: 'idle',
                actions: [
                  assign({
                    items: ({ context, event }) => {
                      const { item: sent, admission } = event.output
                      if (admission.kind === 'replayed') return context.items.filter((item) => item.itemId !== sent.itemId)
                      // The same bytes selected twice join one attempt: one card for one workflow.
                      const held = context.items.some((item) =>
                        isUpload(item) && item.status === 'admitted' && item.projectContextId === sent.projectContextId &&
                        item.workflowId === admission.workflowId)
                      return held
                        ? context.items.filter((item) => item.itemId !== sent.itemId)
                        : context.items.map((item) =>
                            item.itemId === sent.itemId
                              ? { ...item, status: 'admitted' as const, workflowId: admission.workflowId } as UploadItem
                              : item)
                    },
                  }),
                  ({ context, event }) => {
                    const { item, admission } = event.output
                    if (admission.kind === 'replayed') context.onReplayed(item, admission.document)
                    else context.onAdmitted(item, admission.workflowId)
                  },
                ],
              },
              { target: 'idle' },
            ],
            onError: [
              {
                guard: ({ context }) => context.items.some((item) => isUpload(item) && item.status === 'sending'),
                target: 'idle',
                actions: assign({
                  items: ({ context, event }) =>
                    context.items.map((item) =>
                      isUpload(item) && item.status === 'sending'
                        ? { ...item, status: 'failed' as const, failure: context.toFailureMessage(event.error), uncertain: context.isUncertain(event.error) }
                        : item),
                }),
              },
              { target: 'idle' },
            ],
          },
        },
      },
    },
    reprocesses: {
      initial: 'idle',
      states: {
        idle: {
          always: { guard: 'hasQueuedReprocess', target: 'parsing', actions: [{ type: 'startNextReprocess' }] },
        },
        parsing: {
          invoke: {
            src: 'reprocessCurrent',
            input: ({ context }) => ({
              item: context.items.find((item) => isReprocess(item) && item.status === 'parsing')!,
              reprocess: context.reprocess,
            }),
            onDone: [
              {
                guard: ({ context, event }) => context.items.some((item) => item.itemId === event.output.item.itemId),
                target: 'idle',
                actions: [
                  // Dropping the in-flight entry and acknowledging the new revision in one transition: no duplicate,
                  // no gap.
                  assign({ items: ({ context, event }) => context.items.filter((item) => item.itemId !== event.output.item.itemId) }),
                  ({ context, event }) => context.onIngested(event.output),
                ],
              },
              { target: 'idle' },
            ],
            onError: [
              {
                guard: ({ context }) => context.items.some((item) => isReprocess(item) && item.status === 'parsing'),
                target: 'idle',
                actions: assign({
                  items: ({ context, event }) =>
                    context.items.map((item) =>
                      isReprocess(item) && item.status === 'parsing'
                        ? { ...item, status: 'failed' as const, failure: context.toFailureMessage(event.error), uncertain: context.isUncertain(event.error) }
                        : item),
                }),
              },
              { target: 'idle' },
            ],
          },
        },
      },
    },
  },
})
