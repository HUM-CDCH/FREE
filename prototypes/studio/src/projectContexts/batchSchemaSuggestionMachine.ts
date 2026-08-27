import { assign, fromPromise, setup } from 'xstate'
import type { SchemaDefinition } from 'extraction/schema'
import type { BatchSchemaSuggestion } from '../../shared/batchSchemaSuggestion.contract'
import type { ExtractionStrategy } from '../../shared/extraction.contract'

export type BatchSchemaSuggestionOperations = {
  create(sourceDocumentIds: readonly string[]): Promise<BatchSchemaSuggestion>
  retry(batchSchemaSuggestionId: string): Promise<BatchSchemaSuggestion>
  save(
    suggestion: BatchSchemaSuggestion,
    definition: SchemaDefinition,
  ): Promise<BatchSchemaSuggestion>
  run(
    batchSchemaSuggestionId: string,
    strategy: ExtractionStrategy,
  ): Promise<BatchSchemaSuggestion>
  isConflict(error: unknown): boolean
  failureMessage(error: unknown, fallback: string): string
  onSuggestion(suggestion: BatchSchemaSuggestion): void
  onRun(suggestion: BatchSchemaSuggestion): void
}

type Context = BatchSchemaSuggestionOperations & {
  sourceDocumentIds: readonly string[]
  suggestion: BatchSchemaSuggestion | null
  draft: SchemaDefinition | null
  error: string | null
}

type Event =
  | {
      type: 'selection.changed'
      sourceDocumentIds: readonly string[]
      suggestion: BatchSchemaSuggestion | null
    }
  | { type: 'suggestion.updated'; suggestion: BatchSchemaSuggestion }
  | { type: 'suggestion.requested' }
  | { type: 'suggestion.retry' }
  | { type: 'proposal.changed'; definition: SchemaDefinition }
  | { type: 'proposal.recovered'; definition: SchemaDefinition }
  | { type: 'draft.flush' }
  | { type: 'run.requested'; strategy: ExtractionStrategy }
  | { type: 'reset' }

const createSuggestion = fromPromise<
  BatchSchemaSuggestion,
  Pick<Context, 'create' | 'sourceDocumentIds'>
>(({ input }) => input.create(input.sourceDocumentIds))

const retrySuggestion = fromPromise<
  BatchSchemaSuggestion,
  Pick<Context, 'retry'> & { batchSchemaSuggestionId: string }
>(({ input }) => input.retry(input.batchSchemaSuggestionId))

const saveDraft = fromPromise<
  { suggestion: BatchSchemaSuggestion; definition: SchemaDefinition },
  Pick<Context, 'save'> & {
    suggestion: BatchSchemaSuggestion
    definition: SchemaDefinition
  }
>(async ({ input }) => ({
  suggestion: await input.save(input.suggestion, input.definition),
  definition: input.definition,
}))

const runSuggestion = fromPromise<
  BatchSchemaSuggestion,
  Pick<Context, 'run'> & {
    batchSchemaSuggestionId: string
    strategy: ExtractionStrategy
  }
>(({ input }) => input.run(input.batchSchemaSuggestionId, input.strategy))

function suggestionOutput(event: object): BatchSchemaSuggestion | null {
  if (!('output' in event)) return null
  const output = event.output
  return (
    output !== null &&
    typeof output === 'object' &&
    'batchSchemaSuggestionId' in output &&
    'draft' in output
  )
    ? (output as BatchSchemaSuggestion)
    : null
}

function saveOutput(event: object): {
  suggestion: BatchSchemaSuggestion
  definition: SchemaDefinition
} | null {
  if (!('output' in event)) return null
  const output = event.output
  if (
    output === null ||
    typeof output !== 'object' ||
    !('suggestion' in output) ||
    !('definition' in output)
  )
    return null
  const suggestion = output.suggestion
  const definition = output.definition
  if (
    suggestion === null ||
    typeof suggestion !== 'object' ||
    !('batchSchemaSuggestionId' in suggestion) ||
    definition === null ||
    typeof definition !== 'object' ||
    !('recordDescription' in definition) ||
    !('schemaNodes' in definition)
  )
    return null
  return {
    suggestion: suggestion as BatchSchemaSuggestion,
    definition: definition as SchemaDefinition,
  }
}

export const batchSchemaSuggestionMachine = setup({
  types: {
    context: {} as Context,
    events: {} as Event,
    input: {} as BatchSchemaSuggestionOperations,
  },
  actors: {
    createSuggestion,
    retrySuggestion,
    saveDraft,
    runSuggestion,
  },
  actions: {
    clear: assign({
      sourceDocumentIds: () => [],
      suggestion: () => null,
      draft: () => null,
      error: () => null,
    }),
    adoptSelection: assign({
      sourceDocumentIds: ({ event }) =>
        event.type === 'selection.changed' ? event.sourceDocumentIds : [],
      suggestion: ({ event }) =>
        event.type === 'selection.changed' ? event.suggestion : null,
      draft: ({ event }) =>
        event.type === 'selection.changed' ? event.suggestion?.draft ?? null : null,
      error: () => null,
    }),
    adoptUpdatedSuggestion: assign({
      suggestion: ({ event }) =>
        event.type === 'suggestion.updated' ? event.suggestion : null,
      draft: ({ event }) =>
        event.type === 'suggestion.updated' ? event.suggestion.draft : null,
      error: () => null,
    }),
    adoptActorSuggestion: assign({
      suggestion: ({ event }) => suggestionOutput(event),
      draft: ({ event }) => suggestionOutput(event)?.draft ?? null,
      error: () => null,
    }),
    editProposal: assign({
      draft: ({ context, event }) =>
        event.type === 'proposal.changed' || event.type === 'proposal.recovered'
          ? event.definition
          : context.draft,
      suggestion: ({ context, event }) =>
        (event.type === 'proposal.changed' ||
          event.type === 'proposal.recovered') && context.suggestion
          ? { ...context.suggestion, draft: event.definition }
          : context.suggestion,
      error: () => null,
    }),
    acceptSave: assign({
      suggestion: ({ context, event }) => {
        const output = saveOutput(event)
        if (!output) return context.suggestion
        return context.draft !== output.definition && context.draft
          ? { ...output.suggestion, draft: context.draft }
          : output.suggestion
      },
      draft: ({ context, event }) => {
        const output = saveOutput(event)
        if (!output) return context.draft
        return context.draft !== output.definition
          ? context.draft
          : output.suggestion.draft
      },
      error: () => null,
    }),
    captureCreateFailure: assign({
      error: ({ context, event }) =>
        'error' in event
          ? context.failureMessage(
              event.error,
              'Common fields could not be suggested.',
            )
          : null,
    }),
    captureRetryFailure: assign({
      error: ({ context, event }) =>
        'error' in event
          ? context.failureMessage(
              event.error,
              'The suggestion could not be regenerated.',
            )
          : null,
    }),
    captureSaveFailure: assign({
      error: ({ context, event }) =>
        'error' in event
          ? context.failureMessage(
              event.error,
              'The suggested draft could not be saved.',
            )
          : null,
    }),
    captureRunFailure: assign({
      error: ({ context, event }) =>
        'error' in event
          ? context.failureMessage(
              event.error,
              'The suggested Batch Extraction could not start.',
            )
          : null,
    }),
    notifySuggestion: ({ context }) => {
      if (context.suggestion) context.onSuggestion(context.suggestion)
    },
    notifyRun: ({ context }) => {
      if (context.suggestion) context.onRun(context.suggestion)
    },
  },
  guards: {
    hasSelection: ({ context }) => context.sourceDocumentIds.length > 0,
    suggestionRunning: ({ context }) =>
      context.suggestion?.executionStatus === 'QUEUED' ||
      context.suggestion?.executionStatus === 'RUNNING',
    suggestionFailed: ({ context }) =>
      context.suggestion?.executionStatus === 'FAILED',
    suggestionConfirmed: ({ context }) =>
      context.suggestion !== null &&
      context.suggestion.confirmedSchemaRevisionId !== null,
    suggestionHeterogeneous: ({ context }) =>
      context.suggestion?.phase === 'HETEROGENEOUS',
    suggestionReady: ({ context }) =>
      context.suggestion?.phase === 'READY' && context.draft !== null,
    hasNewerDraft: ({ context, event }) => {
      const output = saveOutput(event)
      return output !== null && context.draft !== output.definition
    },
    saveConflict: ({ context, event }) =>
      'error' in event && context.isConflict(event.error),
  },
}).createMachine({
  id: 'batchSchemaSuggestion',
  context: ({ input }) => ({
    ...input,
    sourceDocumentIds: [],
    suggestion: null,
    draft: null,
    error: null,
  }),
  initial: 'idle',
  on: {
    reset: { target: '.idle', actions: [{ type: 'clear' }] },
    'selection.changed': {
      target: '.adopting',
      actions: [{ type: 'adoptSelection' }],
    },
  },
  states: {
    idle: {
      on: {
        'suggestion.requested': {
          guard: 'hasSelection',
          target: 'creating',
        },
        'suggestion.updated': {
          target: 'adopting',
          actions: [{ type: 'adoptUpdatedSuggestion' }],
        },
      },
    },
    creating: {
      invoke: {
        src: 'createSuggestion',
        input: ({ context }) => ({
          create: context.create,
          sourceDocumentIds: context.sourceDocumentIds,
        }),
        onDone: {
          target: 'adopting',
          actions: [
            { type: 'adoptActorSuggestion' },
            { type: 'notifySuggestion' },
          ],
        },
        onError: {
          target: 'idle',
          actions: [{ type: 'captureCreateFailure' }],
        },
      },
    },
    adopting: {
      always: [
        { guard: 'suggestionRunning', target: 'suggesting' },
        { guard: 'suggestionFailed', target: 'failed' },
        { guard: 'suggestionConfirmed', target: 'confirmed' },
        { guard: 'suggestionHeterogeneous', target: 'heterogeneous' },
        { guard: 'suggestionReady', target: 'drafting.clean' },
        { target: 'idle' },
      ],
    },
    suggesting: {
      on: {
        'suggestion.updated': {
          target: 'adopting',
          actions: [{ type: 'adoptUpdatedSuggestion' }],
        },
      },
    },
    failed: {
      on: {
        'suggestion.retry': { target: 'retrying' },
        'suggestion.updated': {
          target: 'adopting',
          actions: [{ type: 'adoptUpdatedSuggestion' }],
        },
      },
    },
    heterogeneous: {
      on: {
        'suggestion.retry': { target: 'retrying' },
        'suggestion.updated': {
          target: 'adopting',
          actions: [{ type: 'adoptUpdatedSuggestion' }],
        },
      },
    },
    confirmed: {
      on: {
        'suggestion.retry': { target: 'retrying' },
        'suggestion.updated': {
          target: 'adopting',
          actions: [{ type: 'adoptUpdatedSuggestion' }],
        },
      },
    },
    retrying: {
      invoke: {
        src: 'retrySuggestion',
        input: ({ context }) => ({
          retry: context.retry,
          batchSchemaSuggestionId: context.suggestion!.batchSchemaSuggestionId,
        }),
        onDone: {
          target: 'adopting',
          actions: [
            { type: 'adoptActorSuggestion' },
            { type: 'notifySuggestion' },
          ],
        },
        onError: {
          target: 'failed',
          actions: [{ type: 'captureRetryFailure' }],
        },
      },
    },
    drafting: {
      initial: 'clean',
      states: {
        clean: {
          on: {
            'proposal.recovered': {
              target: 'dirty',
              actions: [
                { type: 'editProposal' },
                { type: 'notifySuggestion' },
              ],
            },
            'proposal.changed': {
              target: 'dirty',
              actions: [
                { type: 'editProposal' },
                { type: 'notifySuggestion' },
              ],
            },
            'run.requested': { target: '#batchSchemaSuggestion.running' },
            'suggestion.retry': { target: '#batchSchemaSuggestion.retrying' },
            'suggestion.updated': {
              target: '#batchSchemaSuggestion.adopting',
              actions: [{ type: 'adoptUpdatedSuggestion' }],
            },
          },
        },
        dirty: {
          after: { 500: { target: 'saving' } },
          on: {
            'proposal.changed': {
              actions: [
                { type: 'editProposal' },
                { type: 'notifySuggestion' },
              ],
            },
            'draft.flush': { target: 'saving' },
          },
        },
        saving: {
          on: {
            'proposal.changed': {
              actions: [
                { type: 'editProposal' },
                { type: 'notifySuggestion' },
              ],
            },
          },
          invoke: {
            src: 'saveDraft',
            input: ({ context }) => ({
              save: context.save,
              suggestion: context.suggestion!,
              definition: context.draft!,
            }),
            onDone: [
              {
                guard: 'hasNewerDraft',
                target: 'saving',
                reenter: true,
                actions: [
                  { type: 'acceptSave' },
                  { type: 'notifySuggestion' },
                ],
              },
              {
                target: 'clean',
                actions: [
                  { type: 'acceptSave' },
                  { type: 'notifySuggestion' },
                ],
              },
            ],
            onError: [
              {
                guard: 'saveConflict',
                target: '#batchSchemaSuggestion.conflict',
                actions: [{ type: 'captureSaveFailure' }],
              },
              {
                target: 'saveFailed',
                actions: [{ type: 'captureSaveFailure' }],
              },
            ],
          },
        },
        saveFailed: {
          on: {
            'proposal.changed': {
              target: 'dirty',
              actions: [
                { type: 'editProposal' },
                { type: 'notifySuggestion' },
              ],
            },
            'draft.flush': { target: 'saving' },
          },
        },
      },
    },
    conflict: {
      on: {
        'suggestion.updated': {
          target: 'adopting',
          actions: [{ type: 'adoptUpdatedSuggestion' }],
        },
      },
    },
    running: {
      invoke: {
        src: 'runSuggestion',
        input: ({ context, event }) => ({
          run: context.run,
          batchSchemaSuggestionId: context.suggestion!.batchSchemaSuggestionId,
          strategy:
            event.type === 'run.requested' ? event.strategy : 'ARTICLE',
        }),
        onDone: {
          target: 'confirmed',
          actions: [
            { type: 'adoptActorSuggestion' },
            { type: 'notifySuggestion' },
            { type: 'notifyRun' },
          ],
        },
        onError: {
          target: 'drafting.clean',
          actions: [{ type: 'captureRunFailure' }],
        },
      },
    },
  },
})
