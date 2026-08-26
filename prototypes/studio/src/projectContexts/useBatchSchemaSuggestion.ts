import { useEffect } from 'react'
import { useMachine } from '@xstate/react'
import type { BatchSchemaSuggestion } from '../../shared/batchSchemaSuggestion.contract'
import {
  BatchSchemaSuggestionRequestError,
  createBatchSchemaSuggestion,
  retryBatchSchemaSuggestion,
  runBatchSchemaSuggestion,
  updateBatchSchemaSuggestionDraft,
} from './batchExtractions'
import { batchSchemaSuggestionMachine } from './batchSchemaSuggestionMachine'

export function useBatchSchemaSuggestion({
  projectContextId,
  onSuggestion,
  onRun,
}: {
  projectContextId: string
  onSuggestion(suggestion: BatchSchemaSuggestion): void
  onRun(suggestion: BatchSchemaSuggestion): void
}) {
  const [snapshot, send] = useMachine(batchSchemaSuggestionMachine, {
    input: {
      create: (sourceDocumentIds) =>
        createBatchSchemaSuggestion(projectContextId, sourceDocumentIds),
      retry: (batchSchemaSuggestionId) =>
        retryBatchSchemaSuggestion(projectContextId, batchSchemaSuggestionId),
      save: (suggestion, definition) =>
        updateBatchSchemaSuggestionDraft(
          projectContextId,
          suggestion.batchSchemaSuggestionId,
          definition,
          suggestion.draftVersion,
        ),
      run: (batchSchemaSuggestionId, strategy) =>
        runBatchSchemaSuggestion(
          projectContextId,
          batchSchemaSuggestionId,
          strategy,
        ),
      isConflict: (error) =>
        error instanceof BatchSchemaSuggestionRequestError &&
        error.failure.code === 'draft_conflict',
      failureMessage: (error, fallback) =>
        error instanceof Error ? error.message : fallback,
      onSuggestion,
      onRun,
    },
  })

  useEffect(() => {
    const flush = () => send({ type: 'draft.flush' })
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [send])

  return [snapshot, send] as const
}
