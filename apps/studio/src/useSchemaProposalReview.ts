import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { SchemaNode } from 'extraction/schema'
import { deleteModelOperation } from './api'
import type { SchemaEditorController } from './currentSchemaRevision'
import {
  replaySchemaChanges,
  toggleAcceptedSchemaChange,
  type DerivedProposal,
} from '../shared/schemaChanges'

export type PendingSchemaProposal = DerivedProposal & {
  original: SchemaNode[]
  /** The proposal's `edit:` workflow, when Studio recorded one: Discard deletes it so a reload cannot reopen it. */
  workflowId: string | null
  ownership: ReturnType<SchemaEditorController['markProposal']>
}

export type SchemaProposalReview = {
  readonly pending: PendingSchemaProposal | null
  readonly acceptedChangeIds: ReadonlySet<string>
  readonly replay: ReturnType<typeof replaySchemaChanges> | null
  readonly canApply: boolean
  start(
    proposal: DerivedProposal,
    original: SchemaNode[],
    originalDraftVersion: number,
    originalSchemaRevisionId: string | null,
    workflowId: string | null,
  ): void
  toggle(changeId: string): void
  /** True when the proposal was applied; false when it was refused (kept for review) or discarded as stale. */
  apply(): boolean
  discard(): void
  reset(): void
}

/** Owns proposal acceptance, invariant-safe replay, apply, discard, and reset. */
export function useSchemaProposalReview(
  schema: SchemaEditorController,
  appendMessage: (message: string) => void,
): SchemaProposalReview {
  useSyncExternalStore(schema.subscribe, schema.snapshot)
  const marker = useRef<ReturnType<SchemaEditorController['markProposal']> | null>(null)
  useEffect(() => () => marker.current?.release(), [schema])
  const [pending, setPending] = useState<PendingSchemaProposal | null>(null)
  const [acceptedChangeIds, setAcceptedChangeIds] = useState<Set<string>>(
    new Set(),
  )
  const replay = useMemo(
    () =>
      pending
        ? replaySchemaChanges(
            pending.original,
            pending.changes,
            acceptedChangeIds,
          )
        : null,
    [acceptedChangeIds, pending],
  )

  const reset = useCallback(() => {
    if (!pending || marker.current !== pending.ownership) return
    pending.ownership.release()
    marker.current = null
    setPending(null)
    setAcceptedChangeIds(new Set())
  }, [pending])

  const start = useCallback(
    (
      proposal: DerivedProposal,
      original: SchemaNode[],
      originalDraftVersion: number,
      originalSchemaRevisionId: string | null,
      workflowId: string | null,
    ) => {
      marker.current?.release()
      marker.current = schema.markProposal({ draftVersion: originalDraftVersion, schemaRevisionId: originalSchemaRevisionId })
      setAcceptedChangeIds(new Set(proposal.changes.map(({ id }) => id)))
      setPending({
        ...proposal,
        original,
        workflowId,
        ownership: marker.current,
      })
    },
    [schema],
  )

  const toggle = useCallback((changeId: string) => {
    setAcceptedChangeIds((current) => {
      if (!pending) return current
      return toggleAcceptedSchemaChange(pending.changes, current, changeId)
    })
  }, [pending])

  const apply = useCallback(() => {
    if (!pending || marker.current !== pending.ownership || !replay?.hasChanges) return false
    const result = pending.ownership.apply(
      () => replay.nodes,
      '✦ Template updated via chat',
    )
    if (!result.ok) {
      if (result.reason === 'stale') { appendMessage(result.message); reset() }
      else appendMessage(result.reason === 'duplicate-name'
        ? `Cannot apply the proposal: a sibling field already uses “${result.duplicateName}”.`
        : result.reason === 'no-draft' ? 'Cannot apply the proposal because no template draft is open.' : result.message)
      return false
    }
    appendMessage(
      `✓ ${replay.appliedCount} template change${replay.appliedCount === 1 ? '' : 's'} applied.`,
    )
    reset()
    return true
  }, [appendMessage, pending, replay, reset])

  const discard = useCallback(() => {
    if (!pending || marker.current !== pending.ownership) return
    // Discard persists: the proposal's workflow goes, so a reload cannot bring it back. Apply does not delete — the
    // base moves, so the proposal no longer restores.
    if (pending.workflowId)
      void deleteModelOperation(pending.workflowId).catch(() =>
        appendMessage('The proposal could not be discarded on the server; it may return after a reload.'),
      )
    appendMessage('Okay — discarded, no changes made.')
    reset()
  }, [appendMessage, pending, reset])

  return {
    pending,
    acceptedChangeIds,
    replay,
    canApply: (replay?.hasChanges ?? false) && (pending?.ownership.validity().ok ?? false),
    start,
    toggle,
    apply,
    discard,
    reset,
  }
}
