import { useCallback, useMemo, useState } from 'react'
import type { SchemaNode } from 'extraction/schema'
import type { SchemaEditorController } from './currentSchemaRevision'
import {
  replaySchemaChanges,
  toggleAcceptedSchemaChange,
  type DerivedProposal,
} from '../shared/schemaChanges'

export type PendingSchemaProposal = DerivedProposal & {
  original: SchemaNode[]
  originalDraftVersion: number
  originalSchemaRevisionId: string | null
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
  ): void
  toggle(changeId: string): void
  apply(): void
  discard(): void
  reset(): void
}

/** Owns proposal acceptance, invariant-safe replay, apply, discard, and reset. */
export function useSchemaProposalReview(
  schema: SchemaEditorController,
  appendMessage: (message: string) => void,
): SchemaProposalReview {
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
    setPending(null)
    setAcceptedChangeIds(new Set())
  }, [])

  const start = useCallback(
    (
      proposal: DerivedProposal,
      original: SchemaNode[],
      originalDraftVersion: number,
      originalSchemaRevisionId: string | null,
    ) => {
      setAcceptedChangeIds(new Set(proposal.changes.map(({ id }) => id)))
      setPending({
        ...proposal,
        original,
        originalDraftVersion,
        originalSchemaRevisionId,
      })
    },
    [],
  )

  const toggle = useCallback((changeId: string) => {
    setAcceptedChangeIds((current) => {
      if (!pending) return current
      return toggleAcceptedSchemaChange(pending.changes, current, changeId)
    })
  }, [pending])

  const apply = useCallback(() => {
    if (!pending || !replay?.hasChanges) return
    const current = schema.snapshot()
    if (
      current.draftVersion !== pending.originalDraftVersion ||
      current.extractableSchemaRevisionId !== pending.originalSchemaRevisionId
    ) {
      appendMessage('Schema changed during review. The proposal was discarded.')
      reset()
      return
    }
    const result = schema.commit(
      () => replay.nodes,
      '✦ Schema updated via chat',
    )
    if (!result.ok) {
      appendMessage(
        result.reason === 'duplicate-name'
          ? `Cannot apply the proposal: a sibling field already uses “${result.duplicateName}”.`
          : 'Cannot apply the proposal because no schema draft is open.',
      )
      return
    }
    appendMessage(
      `✓ ${replay.appliedCount} schema change${replay.appliedCount === 1 ? '' : 's'} applied.`,
    )
    reset()
  }, [appendMessage, pending, replay, reset, schema])

  const discard = useCallback(() => {
    if (!pending) return
    appendMessage('Okay — discarded, no changes made.')
    reset()
  }, [appendMessage, pending, reset])

  return {
    pending,
    acceptedChangeIds,
    replay,
    canApply: replay?.hasChanges ?? false,
    start,
    toggle,
    apply,
    discard,
    reset,
  }
}
