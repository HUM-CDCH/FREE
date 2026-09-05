import { useEffect, useMemo, useRef, useState } from 'react'
import { enumerateFieldPaths, type SchemaNode } from 'extraction/schema'
import { finalizeExtractionReview, readExtraction } from './api'
import { applyReviewDecisions, resultPathKey } from './reviewDecisions'
import { isRecord } from '../shared/template'
import type { BatchExtraction } from '../shared/batchExtraction.contract'
import type {
  ExtractionAttempt,
  ReviewDecisionAction,
  ReviewDecisionInput,
} from '../shared/extraction.contract'

export type GridColumn = {
  key: string
  path: readonly string[]
  node: SchemaNode
}

export type MemberReviewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready'
      attempt: ExtractionAttempt
      decisions: readonly ReviewDecisionInput[]
      touched: ReadonlySet<string>
      /** Grounded and not yet finalized — false once reviewed or ungrounded. */
      editable: boolean
      saving: boolean
      saveError: string | null
    }

function isInternalFieldName(name: string): boolean {
  const normalized = name.toLowerCase()
  return name.startsWith('_') || normalized === 'evidence' || normalized === 'internal'
}

function buildColumns(schemaNodes: readonly SchemaNode[] | null): GridColumn[] {
  if (!schemaNodes) return []
  return enumerateFieldPaths(schemaNodes)
    .filter(
      (field) => !field.node.children && !field.path.some(isInternalFieldName),
    )
    .map((field) => ({
      key: field.key,
      path: field.path,
      node: field.node,
    }))
}

/** Expand one schema column into actual indexed scalar paths, without joining sibling arrays. */
export function valuesAtColumn(record: unknown, column: GridColumn): Array<{
  path: (string | number)[]
  value: unknown
}> {
  const visit = (value: unknown, remaining: readonly string[], path: (string | number)[]): ReturnType<typeof valuesAtColumn> => {
    if (Array.isArray(value))
      return value.flatMap((item, index) => visit(item, remaining, [...path, index]))
    if (remaining.length === 0) return [{ path, value }]
    const [name, ...rest] = remaining
    return visit(isRecord(value) ? value[name] : undefined, rest, [...path, name])
  }
  return visit(record, column.path, [])
}

export function decisionMatchesColumn(path: readonly (string | number)[], column: GridColumn): boolean {
  if (path[0] !== 'records' || typeof path[1] !== 'number') return false
  const fields = path.slice(2).filter((segment) => typeof segment === 'string')
  return fields.length === column.path.length && fields.every((field, index) => field === column.path[index])
}

export function pendingReviewCount(state: MemberReviewState): number {
  return state.status === 'ready'
    ? state.decisions.filter((decision) => !state.touched.has(resultPathKey(decision.resultPath))).length
    : 0
}

/** The reviewed projection of one Extraction's records, ready to read cells from. */
export function projectedRecords(
  attempt: ExtractionAttempt,
  decisions: readonly ReviewDecisionInput[],
): readonly unknown[] {
  const projected = applyReviewDecisions(attempt.resultPayload ?? {}, decisions)
  return isRecord(projected) && Array.isArray(projected.records)
    ? projected.records
    : []
}

function failureText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/**
 * Fetches and stages Review Decisions for every reviewable member of one
 * Batch Extraction, so a spreadsheet-style grid can approve/reject/edit
 * fields across many Source Documents and save them together. Mirrors the
 * staged-decisions-then-finalization shape of `useExtraction`'s `review`,
 * just fanned out over one member per Source Document instead of one attempt.
 */
export function useBatchExtractionReviewGrid(
  batch: BatchExtraction,
  schemaNodes: readonly SchemaNode[] | null,
  /** Called after each member saves, so the batch's own member list (and its
   *  Reviewed/Needs review pills) can be refreshed from the server. */
  onMemberSaved?: () => void,
) {
  const columns = useMemo(() => buildColumns(schemaNodes), [schemaNodes])
  const [members, renderMembers] = useState<ReadonlyMap<string, MemberReviewState>>(
    new Map(),
  )
  const membersRef = useRef(members)
  const loadControllerRef = useRef<AbortController | null>(null)
  const scopeRef = useRef<object | null>(null)
  // Publish state synchronously so a second event cannot edit or save an older snapshot.
  function setMembers(update: (current: ReadonlyMap<string, MemberReviewState>) => ReadonlyMap<string, MemberReviewState>) {
    membersRef.current = update(membersRef.current)
    renderMembers(membersRef.current)
  }
  useEffect(() => {
    scopeRef.current = {}
    setMembers(() => new Map())
    return () => { scopeRef.current = null }
  }, [batch.batchExtractionId])

  // Identity, not reference: `batch` is re-fetched by the panel above (it
  // polls while a batch is running), so depending on `batch.members` itself
  // would refetch every result on every poll tick.
  const memberFetchKey = batch.members
    .map(
      (member) =>
        `${member.sourceDocumentId}:${member.latestExtraction?.extractionId ?? ''}:${member.latestExtraction?.outcome ?? ''}`,
    )
    .join('|')

  function loadMember(sourceDocumentId: string, extractionId: string, signal: AbortSignal) {
    setMembers((current) => new Map(current).set(sourceDocumentId, { status: 'loading' }))
    readExtraction(extractionId, signal).then(
      ({ extraction, pendingReviewDecisions }) => {
        if (signal.aborted) return
        const decisions = extraction.reviewedAt
          ? extraction.reviewDecisions
          : pendingReviewDecisions ?? []
        setMembers((current) =>
          new Map(current).set(sourceDocumentId, {
            status: 'ready',
            attempt: extraction,
            decisions,
            // Already-saved decisions were all explicitly made, not
            // defaulted — this is a read of a finalized review, so every
            // field is "touched" (mirrors useExtraction.ts).
            touched: extraction.reviewedAt
              ? new Set(decisions.map((decision) => resultPathKey(decision.resultPath)))
              : new Set(),
            editable: extraction.reviewable && extraction.reviewedAt === null,
            saving: false,
            saveError: null,
          }),
        )
      },
      (error: unknown) => {
        if (signal.aborted) return
        setMembers((current) =>
          new Map(current).set(sourceDocumentId, {
            status: 'error',
            message: failureText(error, 'This Extraction Result could not be read.'),
          }),
        )
      },
    )
  }

  useEffect(() => {
    const controller = new AbortController()
    loadControllerRef.current = controller
    const successful = new Map(batch.members
      .filter((member) => member.latestExtraction?.outcome === 'SUCCEEDED')
      .map((member) => [member.sourceDocumentId, member.latestExtraction!.extractionId]))
    setMembers((current) => new Map([...current].filter(([id, state]) =>
      state.status === 'ready' && state.attempt.extractionId === successful.get(id),
    )))
    for (const member of batch.members) {
      if (member.latestExtraction?.outcome === 'SUCCEEDED' && !membersRef.current.has(member.sourceDocumentId))
        loadMember(member.sourceDocumentId, member.latestExtraction.extractionId, controller.signal)
    }
    return () => controller.abort()
    // memberFetchKey stands in for batch.members: it changes only when a
    // member's extraction identity/outcome actually changes, not on every
    // poll tick of the same running batch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch.batchExtractionId, memberFetchKey])

  function retryMember(sourceDocumentId: string) {
    const state = membersRef.current.get(sourceDocumentId)
    if (state?.status === 'ready' && (state.saving || state.touched.size > 0)) return
    const member = batch.members.find((item) => item.sourceDocumentId === sourceDocumentId)
    const signal = loadControllerRef.current?.signal
    if (member?.latestExtraction?.outcome === 'SUCCEEDED' && signal)
      loadMember(sourceDocumentId, member.latestExtraction.extractionId, signal)
  }

  function setDecision(
    sourceDocumentId: string,
    resultPath: ReviewDecisionInput['resultPath'],
    action: ReviewDecisionAction,
    reviewedValue: ReviewDecisionInput['reviewedValue'] = null,
  ) {
    const key = resultPathKey(resultPath)
    setMembers((current) => {
      const state = current.get(sourceDocumentId)
      if (!state || state.status !== 'ready' || !state.editable || state.saving) return current
      if (!state.decisions.some((decision) => resultPathKey(decision.resultPath) === key)) return current
      const next = new Map(current)
      next.set(sourceDocumentId, {
        ...state,
        decisions: state.decisions.map((decision) =>
          resultPathKey(decision.resultPath) === key
            ? { ...decision, action, reviewedValue: action === 'EDITED' ? reviewedValue : null }
            : decision,
        ),
        touched: new Set(state.touched).add(key),
      })
      return next
    })
  }

  // Marks every field of this member's decisions as touched, without
  // changing its recorded action — every field already defaults to
  // 'APPROVED', so this only affects what the review UI displays. Mirrors
  // useExtraction.ts's approveAllRemaining.
  function approveAllForMember(sourceDocumentId: string) {
    setMembers((current) => {
      const state = current.get(sourceDocumentId)
      if (!state || state.status !== 'ready' || !state.editable || state.saving) return current
      const next = new Map(current)
      next.set(sourceDocumentId, {
        ...state,
        touched: new Set([
          ...state.touched,
          ...state.decisions.map((decision) => resultPathKey(decision.resultPath)),
        ]),
      })
      return next
    })
  }

  function approveAll() {
    for (const sourceDocumentId of membersRef.current.keys())
      approveAllForMember(sourceDocumentId)
  }

  /** Approves every field of one displayed grid row: one record of one member. */
  function approveRow(sourceDocumentId: string, recordIndex: number) {
    setMembers((current) => {
      const state = current.get(sourceDocumentId)
      if (!state || state.status !== 'ready' || !state.editable || state.saving) return current
      const matching = state.decisions.filter(
        (decision) => decision.resultPath[0] === 'records' && decision.resultPath[1] === recordIndex,
      )
      if (matching.length === 0) return current
      const next = new Map(current)
      next.set(sourceDocumentId, {
        ...state,
        touched: new Set([
          ...state.touched,
          ...matching.map((decision) => resultPathKey(decision.resultPath)),
        ]),
      })
      return next
    })
  }

  /** Approves one field across every record of every member: one grid column. */
  function approveColumn(column: GridColumn) {
    setMembers((current) => {
      const next = new Map(current)
      let changed = false
      for (const [sourceDocumentId, state] of current) {
        if (state.status !== 'ready' || !state.editable || state.saving) continue
        const matching = state.decisions.filter(
          (decision) =>
            decisionMatchesColumn(decision.resultPath, column),
        )
        if (matching.length === 0) continue
        changed = true
        next.set(sourceDocumentId, {
          ...state,
          touched: new Set([
            ...state.touched,
            ...matching.map((decision) => resultPathKey(decision.resultPath)),
          ]),
        })
      }
      return changed ? next : current
    })
  }

  /** Reverses one field back to its unreviewed default — the inverse of
   *  `setDecision`. Restores the "Needs review" state for this field alone. */
  function revertDecision(sourceDocumentId: string, resultPath: ReviewDecisionInput['resultPath']) {
    const key = resultPathKey(resultPath)
    setMembers((current) => {
      const state = current.get(sourceDocumentId)
      if (!state || state.status !== 'ready' || !state.editable || state.saving || !state.touched.has(key))
        return current
      const touched = new Set(state.touched)
      touched.delete(key)
      const next = new Map(current)
      next.set(sourceDocumentId, {
        ...state,
        decisions: state.decisions.map((decision) =>
          resultPathKey(decision.resultPath) === key
            ? { ...decision, action: 'APPROVED', reviewedValue: null }
            : decision,
        ),
        touched,
      })
      return next
    })
  }

  /** Reverses every field of one member back to its unreviewed default — the
   *  inverse of `approveAllForMember`. */
  function revertMember(sourceDocumentId: string) {
    setMembers((current) => {
      const state = current.get(sourceDocumentId)
      if (!state || state.status !== 'ready' || !state.editable || state.saving) return current
      const next = new Map(current)
      next.set(sourceDocumentId, {
        ...state,
        decisions: state.decisions.map((decision) => ({
          ...decision,
          action: 'APPROVED',
          reviewedValue: null,
        })),
        touched: new Set(),
      })
      return next
    })
  }

  function revertAll() {
    for (const sourceDocumentId of membersRef.current.keys()) revertMember(sourceDocumentId)
  }

  /** Reverses every field of one displayed grid row back to its unreviewed
   *  default — the inverse of `approveRow`. */
  function revertRow(sourceDocumentId: string, recordIndex: number) {
    setMembers((current) => {
      const state = current.get(sourceDocumentId)
      if (!state || state.status !== 'ready' || !state.editable || state.saving) return current
      const matchingKeys = new Set(
        state.decisions
          .filter(
            (decision) => decision.resultPath[0] === 'records' && decision.resultPath[1] === recordIndex,
          )
          .map((decision) => resultPathKey(decision.resultPath)),
      )
      if (matchingKeys.size === 0) return current
      const touched = new Set(state.touched)
      for (const key of matchingKeys) touched.delete(key)
      const next = new Map(current)
      next.set(sourceDocumentId, {
        ...state,
        decisions: state.decisions.map((decision) =>
          matchingKeys.has(resultPathKey(decision.resultPath))
            ? { ...decision, action: 'APPROVED', reviewedValue: null }
            : decision,
        ),
        touched,
      })
      return next
    })
  }

  async function saveMember(sourceDocumentId: string) {
    const state = membersRef.current.get(sourceDocumentId)
    if (!state || state.status !== 'ready' || !state.editable || state.saving ||
      state.decisions.length === 0 || pendingReviewCount(state) > 0) return
    const scope = scopeRef.current
    const isCurrent = () => {
      const latest = membersRef.current.get(sourceDocumentId)
      return scope !== null && scopeRef.current === scope && latest?.status === 'ready' &&
        latest.attempt.extractionId === state.attempt.extractionId
    }
    setMembers((current) => {
      const latest = current.get(sourceDocumentId)
      if (!latest || latest.status !== 'ready') return current
      return new Map(current).set(sourceDocumentId, { ...latest, saving: true, saveError: null })
    })
    try {
      const updated = await finalizeExtractionReview(state.attempt.extractionId, state.decisions)
      if (!isCurrent()) return
      setMembers((current) =>
        new Map(current).set(sourceDocumentId, {
          status: 'ready',
          attempt: updated,
          decisions: updated.reviewDecisions,
          // Now finalized — every field was explicitly decided, not
          // defaulted, so every field reads as "touched" from here on.
          touched: new Set(
            updated.reviewDecisions.map((decision) => resultPathKey(decision.resultPath)),
          ),
          editable: false,
          saving: false,
          saveError: null,
        }),
      )
      onMemberSaved?.()
    } catch (error) {
      if (!isCurrent()) return
      setMembers((current) => {
        const latest = current.get(sourceDocumentId)
        if (!latest || latest.status !== 'ready') return current
        return new Map(current).set(sourceDocumentId, {
          ...latest,
          saving: false,
          saveError: failureText(error, 'Saving this review failed.'),
        })
      })
    }
  }

  const dirtyCount = [...members.values()]
    .filter((state) => state.status === 'ready' && state.editable && state.touched.size > 0).length

  return {
    columns,
    members,
    dirtyCount,
    setDecision,
    approveAllForMember,
    approveAll,
    approveRow,
    approveColumn,
    revertDecision,
    revertMember,
    revertAll,
    revertRow,
    saveMember,
    retryMember,
  }
}
