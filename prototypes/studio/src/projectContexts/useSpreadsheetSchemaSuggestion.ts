import { useRef } from 'react'
import { useMachine } from '@xstate/react'
import type {
  BatchSchemaSuggestion,
  BatchSchemaSuggestionPurpose,
} from '../../shared/batchSchemaSuggestion.contract'
import {
  BatchSchemaSuggestionRequestError,
  createSpreadsheetBatchSchemaSuggestion,
  retryBatchSchemaSuggestion,
  runBatchSchemaSuggestion,
  updateBatchSchemaSuggestionDraft,
} from './batchExtractions'
import { batchSchemaSuggestionMachine } from './batchSchemaSuggestionMachine'

/**
 * A spreadsheet-derived suggestion has no document selection to key off
 * of, but the machine's `hasSelection` guard needs a non-empty
 * `sourceDocumentIds` to let `suggestion.requested` through — this
 * sentinel satisfies that guard without meaning anything on its own;
 * `create` below ignores it entirely and reads the project's
 * already-uploaded spreadsheet instead (design.md D2 in
 * openspec/changes/spreadsheet-schema-suggestion: no change to the
 * machine, only a different `create` operation feeding it).
 */
const SPREADSHEET_SELECTION_SENTINEL = ['spreadsheet-upload']

/**
 * Drives the same batch-suggestion draft/edit/confirm flow as
 * `useBatchSchemaSuggestion`, sourced from the Project Context's shared
 * spreadsheet (uploaded separately via `uploadProjectSpreadsheet` — this
 * hook only *reads* whatever version is current, it does not upload one
 * itself, so the same spreadsheet can seed multiple suggestion attempts
 * without re-uploading). A spreadsheet-derived suggestion is built
 * synchronously and is immediately `phase: 'READY'`, so it skips the
 * `creating` -> `suggesting` (SOURCES/MERGING) path the document-grounded
 * flow goes through — `adopting`'s existing `suggestionReady` guard routes
 * it straight to `drafting.clean`.
 */
export function useSpreadsheetSchemaSuggestion({
  projectContextId,
  onSuggestion,
  onRun,
}: {
  projectContextId: string
  onSuggestion(suggestion: BatchSchemaSuggestion): void
  onRun(suggestion: BatchSchemaSuggestion): void
}) {
  const pendingSeparator = useRef<string | undefined>(undefined)
  const pendingPurpose = useRef<BatchSchemaSuggestionPurpose>('SCHEMA')
  const pendingInferTypesFromValues = useRef(true)

  const [snapshot, send] = useMachine(batchSchemaSuggestionMachine, {
    input: {
      create: () =>
        createSpreadsheetBatchSchemaSuggestion(
          projectContextId,
          pendingPurpose.current,
          pendingInferTypesFromValues.current,
          pendingSeparator.current,
        ),
      retry: (batchSchemaSuggestionId, expectedAttempt) =>
        retryBatchSchemaSuggestion(
          projectContextId,
          batchSchemaSuggestionId,
          expectedAttempt,
        ),
      save: (suggestion, definition) =>
        updateBatchSchemaSuggestionDraft(
          projectContextId,
          suggestion.batchSchemaSuggestionId,
          definition,
          suggestion.draftVersion,
        ),
      run: (batchSchemaSuggestionId, strategy, method) =>
        runBatchSchemaSuggestion(
          projectContextId,
          batchSchemaSuggestionId,
          strategy,
          method,
        ),
      isConflict: (error) =>
        error instanceof BatchSchemaSuggestionRequestError &&
        error.failure.code === 'draft_conflict',
      failureMessage: (error, fallback) =>
        error instanceof Error ? error.message : fallback,
      failureCode: (error) =>
        error instanceof BatchSchemaSuggestionRequestError
          ? error.failure.code
          : null,
      onSuggestion,
      onRun,
    },
  })

  /** Creates a suggestion from the project's current spreadsheet version.
   *  Call `uploadProjectSpreadsheet` first if none has been uploaded yet.
   *  `purpose` chooses `SCHEMA` (seed the schema and stop) or
   *  `SCHEMA_AND_VALIDATE` (also populate an Evaluation Corpus version
   *  from this spreadsheet once the suggestion is confirmed).
   *  `inferTypesFromValues` chooses whether field types are guessed from
   *  the spreadsheet's cell values or every field is left as `string`,
   *  reading only the header row. */
  function createFromCurrentSpreadsheet(
    purpose: BatchSchemaSuggestionPurpose,
    inferTypesFromValues: boolean,
    separator?: string,
  ) {
    pendingPurpose.current = purpose
    pendingInferTypesFromValues.current = inferTypesFromValues
    pendingSeparator.current = separator
    send({
      type: 'selection.changed',
      sourceDocumentIds: SPREADSHEET_SELECTION_SENTINEL,
      suggestion: null,
    })
    send({ type: 'suggestion.requested' })
  }

  return [snapshot, send, createFromCurrentSpreadsheet] as const
}
