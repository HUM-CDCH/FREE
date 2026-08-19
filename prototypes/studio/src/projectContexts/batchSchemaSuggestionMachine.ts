import { assign, fromPromise, setup } from 'xstate'
import type {
  BatchSchemaSuggestionFailure,
  BatchSchemaSuggestionMerge,
} from '../../shared/batchSchemaSuggestion.contract'
import type { ExtractionStrategy } from '../../shared/extraction.contract'
import type { SchemaDefinition } from '../../shared/schemaNode'
import {
  BatchSchemaSuggestionRequestError,
  type confirmBatchSchemaSuggestion,
  type mergeBatchSchemaSuggestions,
  type openBatchExtraction,
} from './batchExtractions'

type OpenedBatch = Awaited<ReturnType<typeof openBatchExtraction>>
type ReadyProposal = Extract<BatchSchemaSuggestionMerge, { status: 'ready' }>

type Input = {
  projectContextId: string
  merge: typeof mergeBatchSchemaSuggestions
  confirm: typeof confirmBatchSchemaSuggestion
  open: typeof openBatchExtraction
  onOpened: (opened: OpenedBatch) => void
}

type Context = Input & {
  sourceDocumentIds: string[]
  proposal: BatchSchemaSuggestionMerge | null
  failure: BatchSchemaSuggestionFailure | null
  confirmedRevisionId: string | null
  strategy: ExtractionStrategy
}

type Event =
  | {
      type: 'selection.changed'
      projectContextId: string
      sourceDocumentIds: string[]
    }
  | { type: 'suggestion.requested' }
  | { type: 'proposal.changed'; definition: SchemaDefinition }
  | { type: 'run.requested'; strategy: ExtractionStrategy }
  | { type: 'reset' }

function failureFrom(error: unknown): BatchSchemaSuggestionFailure {
  if (error instanceof BatchSchemaSuggestionRequestError) return error.failure
  return {
    code: 'unexpected_failure',
    message:
      error instanceof Error
        ? error.message
        : 'The Batch Extraction request failed.',
  }
}

export function batchSchemaSuggestionIsValid(
  proposal: BatchSchemaSuggestionMerge | null,
): boolean {
  if (proposal?.status !== 'ready' || !proposal.recordDescription.trim())
    return false
  const names = proposal.schemaNodes.map((node) => node.name.trim())
  return names.every(Boolean) && new Set(names).size === names.length
}

export const batchSchemaSuggestionMachine = setup({
  types: {
    context: {} as Context,
    events: {} as Event,
    input: {} as Input,
  },
  actors: {
    suggest: fromPromise<
      BatchSchemaSuggestionMerge,
      Pick<Context, 'projectContextId' | 'sourceDocumentIds' | 'merge'>
    >(({ input, signal }) =>
      input.merge(input.projectContextId, input.sourceDocumentIds, signal),
    ),
    confirm: fromPromise<
      Awaited<ReturnType<typeof confirmBatchSchemaSuggestion>>,
      Pick<Context, 'projectContextId' | 'sourceDocumentIds' | 'confirm'> & {
        proposal: ReadyProposal
      }
    >(({ input, signal }) =>
      input.confirm(
        input.projectContextId,
        input.sourceDocumentIds,
        input.proposal.selectionKey,
        {
          recordDescription: input.proposal.recordDescription,
          schemaNodes: input.proposal.schemaNodes,
        },
        signal,
      ),
    ),
    open: fromPromise<
      OpenedBatch,
      Pick<
        Context,
        'open' | 'projectContextId' | 'sourceDocumentIds' | 'strategy'
      > & {
        schemaRevisionId: string
      }
    >(({ input, signal }) =>
      input.open(
        {
          projectContextId: input.projectContextId,
          sourceDocumentIds: input.sourceDocumentIds,
          schemaRevisionId: input.schemaRevisionId,
          strategy: input.strategy,
        },
        signal,
      ),
    ),
  },
  actions: {
    clearSuggestion: assign({
      proposal: null,
      failure: null,
      confirmedRevisionId: null,
    }),
    setSelection: assign({
      projectContextId: ({ context, event }) =>
        event.type === 'selection.changed'
          ? event.projectContextId
          : context.projectContextId,
      sourceDocumentIds: ({ context, event }) =>
        event.type === 'selection.changed'
          ? event.sourceDocumentIds
          : context.sourceDocumentIds,
    }),
    setProposal: assign({
      proposal: ({ context, event }) =>
        event.type === 'proposal.changed' && context.proposal
          ? {
              status: 'ready' as const,
              selectionKey: context.proposal.selectionKey,
              ...event.definition,
              coverage:
                context.proposal.status === 'ready'
                  ? context.proposal.coverage
                  : [],
            }
          : context.proposal,
      failure: null,
      confirmedRevisionId: null,
    }),
    setStrategy: assign({
      strategy: ({ context, event }) =>
        event.type === 'run.requested' ? event.strategy : context.strategy,
      failure: null,
    }),
    saveProposal: assign({
      proposal: ({ context, event }) =>
        'output' in event
          ? (event.output as BatchSchemaSuggestionMerge)
          : context.proposal,
      failure: null,
      confirmedRevisionId: null,
    }),
    saveFailure: assign({
      failure: ({ event }) =>
        'error' in event ? failureFrom(event.error) : null,
    }),
    saveConfirmedRevision: assign({
      confirmedRevisionId: ({ context, event }) =>
        'output' in event &&
        typeof event.output === 'object' &&
        event.output !== null &&
        'schemaRevisionId' in event.output
          ? String(event.output.schemaRevisionId)
          : context.confirmedRevisionId,
      failure: null,
    }),
    notifyOpened: ({ context, event }) => {
      if ('output' in event) context.onOpened(event.output as OpenedBatch)
    },
  },
  guards: {
    proposalIsValid: ({ context }) =>
      batchSchemaSuggestionIsValid(context.proposal),
    isRevisionConflict: ({ event }) =>
      'error' in event && failureFrom(event.error).code === 'revision_conflict',
    isSelectionChanged: ({ event }) =>
      'error' in event && failureFrom(event.error).code === 'selection_changed',
  },
}).createMachine({
  id: 'batchSchemaSuggestion',
  context: ({ input }) => ({
    ...input,
    sourceDocumentIds: [],
    proposal: null,
    failure: null,
    confirmedRevisionId: null,
    strategy: 'ARTICLE',
  }),
  initial: 'idle',
  on: {
    'selection.changed': {
      target: '.idle',
      actions: [{ type: 'setSelection' }, { type: 'clearSuggestion' }],
    },
    'proposal.changed': {
      target: '.reviewing',
      guard: ({ context }) => context.proposal !== null,
      actions: [{ type: 'setProposal' }],
    },
    reset: {
      target: '.idle',
      actions: [{ type: 'clearSuggestion' }],
    },
  },
  states: {
    idle: {
      on: { 'suggestion.requested': 'suggesting' },
    },
    suggesting: {
      invoke: {
        src: 'suggest',
        input: ({ context }) => ({
          projectContextId: context.projectContextId,
          sourceDocumentIds: context.sourceDocumentIds,
          merge: context.merge,
        }),
        onDone: {
          target: 'reviewing',
          actions: [{ type: 'saveProposal' }],
        },
        onError: {
          target: 'suggestionFailed',
          actions: [{ type: 'saveFailure' }],
        },
      },
    },
    suggestionFailed: {
      on: { 'suggestion.requested': 'suggesting' },
    },
    reviewing: {
      on: {
        'run.requested': {
          guard: 'proposalIsValid',
          target: 'confirming',
          actions: [{ type: 'setStrategy' }],
        },
      },
    },
    confirming: {
      invoke: {
        src: 'confirm',
        input: ({ context }) => ({
          projectContextId: context.projectContextId,
          sourceDocumentIds: context.sourceDocumentIds,
          proposal: context.proposal as ReadyProposal,
          confirm: context.confirm,
        }),
        onDone: {
          target: 'opening',
          actions: [{ type: 'saveConfirmedRevision' }],
        },
        onError: [
          {
            guard: 'isSelectionChanged',
            target: 'suggestionFailed',
            actions: [{ type: 'clearSuggestion' }, { type: 'saveFailure' }],
          },
          {
            guard: 'isRevisionConflict',
            target: 'suggestionFailed',
            actions: [{ type: 'clearSuggestion' }, { type: 'saveFailure' }],
          },
          {
            target: 'confirmationFailed',
            actions: [{ type: 'saveFailure' }],
          },
        ],
      },
    },
    confirmationFailed: {
      on: {
        'run.requested': {
          target: 'confirming',
          actions: [{ type: 'setStrategy' }],
        },
      },
    },
    opening: {
      invoke: {
        src: 'open',
        input: ({ context }) => ({
          open: context.open,
          projectContextId: context.projectContextId,
          sourceDocumentIds: context.sourceDocumentIds,
          schemaRevisionId: context.confirmedRevisionId!,
          strategy: context.strategy,
        }),
        onDone: {
          target: 'idle',
          actions: [{ type: 'notifyOpened' }, { type: 'clearSuggestion' }],
        },
        onError: {
          target: 'openFailed',
          actions: [{ type: 'saveFailure' }],
        },
      },
    },
    openFailed: {
      on: {
        'run.requested': {
          target: 'opening',
          actions: [{ type: 'setStrategy' }],
        },
      },
    },
  },
})
