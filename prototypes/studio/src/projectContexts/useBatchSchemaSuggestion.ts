import { useEffect, useRef } from 'react'
import { useMachine } from '@xstate/react'
import { schemaDefinitionSchema } from 'extraction/schema'
import type { BatchSchemaSuggestion } from '../../shared/batchSchemaSuggestion.contract'
import {
  BatchSchemaSuggestionRequestError,
  createBatchSchemaSuggestion,
  retryBatchSchemaSuggestion,
  runBatchSchemaSuggestion,
  updateBatchSchemaSuggestionDraft,
} from './batchExtractions'
import { batchSchemaSuggestionMachine } from './batchSchemaSuggestionMachine'
import {
  consumeSessionRecovery,
  registerSessionRecoveryCapture,
  removeSessionRecovery,
} from '../auth/sessionRecovery'

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
      retry: (batchSchemaSuggestionId, expectedAttempt) =>
        retryBatchSchemaSuggestion(projectContextId, batchSchemaSuggestionId, expectedAttempt),
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
      // Another tab saved the draft, or regenerated the suggestion since this page read it: reload it first.
      isConflict: (error) =>
        error instanceof BatchSchemaSuggestionRequestError &&
        (error.failure.code === 'draft_conflict' || error.failure.code === 'attempt_conflict'),
      failureMessage: (error, fallback) =>
        error instanceof Error ? error.message : fallback,
      onSuggestion,
      onRun,
    },
  })
  const restoredVersion = useRef<string | null>(null)

  useEffect(() => {
    const suggestion = snapshot.context.suggestion
    if (!suggestion) return
    return registerSessionRecoveryCapture(
      'batch-schema-draft',
      suggestion.batchSchemaSuggestionId,
      () =>
        (snapshot.matches({ drafting: 'dirty' }) ||
          snapshot.matches({ drafting: 'saving' }) ||
          snapshot.matches({ drafting: 'saveFailed' })) &&
        snapshot.context.draft
          ? {
              draftVersion: suggestion.draftVersion,
              draft: snapshot.context.draft,
            }
          : null,
    )
  }, [snapshot])

  useEffect(() => {
    const suggestion = snapshot.context.suggestion
    if (!suggestion || !snapshot.matches({ drafting: 'clean' })) return
    const version = `${suggestion.batchSchemaSuggestionId}:${suggestion.draftVersion}`
    if (restoredVersion.current === version) return
    restoredVersion.current = version
    const recovered = consumeSessionRecovery(
      'batch-schema-draft',
      suggestion.batchSchemaSuggestionId,
      (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
          return null
        const candidate = value as Record<string, unknown>
        if (candidate.draftVersion !== suggestion.draftVersion) return null
        const parsed = schemaDefinitionSchema.safeParse(candidate.draft)
        return parsed.success ? parsed.data : null
      },
    )
    if (recovered) send({ type: 'proposal.recovered', definition: recovered })
  }, [send, snapshot])

  useEffect(() => {
    const suggestion = snapshot.context.suggestion
    if (
      suggestion &&
      (snapshot.matches('confirmed') ||
        snapshot.matches('heterogeneous') ||
        snapshot.matches('failed') ||
        snapshot.matches('conflict'))
    )
      removeSessionRecovery(
        'batch-schema-draft',
        suggestion.batchSchemaSuggestionId,
      )
  }, [snapshot])

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
