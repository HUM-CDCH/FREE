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
  /** Arrays of scalars are shown as a joined summary, never edited in the grid. */
  editableKind: 'scalar' | 'scalar-array'
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
      editableKind: field.node.type === 'array' ? 'scalar-array' : 'scalar',
    }))
}

function getAtPath(root: unknown, path: readonly (string | number)[]): unknown {
  let current = root
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string | number, unknown>)[segment]
  }
  return current
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

export function valueAtColumn(record: unknown, column: GridColumn): unknown {
  return getAtPath(record, column.path)
}

function failureText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/**
 * Fetches and stages Review Decisions for every reviewable member of one
 * Batch Extraction, so a spreadsheet-style grid can approve/reject/edit
 * fields across many Source Documents and save them together. Mirrors the
 * staged-decisions-then-explicit-save shape of `useExtraction`'s `review`,
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
  const [members, setMembers] = useState<ReadonlyMap<string, MemberReviewState>>(
    new Map(),
  )
  const membersRef = useRef(members)
  useEffect(() => {
    membersRef.current = members
  }, [members])

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
        const decisions = extraction.reviewedAt ? extraction.reviewDecisions : pendingReviewDecisions
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
    for (const member of batch.members) {
      if (member.latestExtraction?.outcome === 'SUCCEEDED')
        loadMember(member.sourceDocumentId, member.latestExtraction.extractionId, controller.signal)
    }
    return () => controller.abort()
    // memberFetchKey stands in for batch.members: it changes only when a
    // member's extraction identity/outcome actually changes, not on every
    // poll tick of the same running batch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch.batchExtractionId, memberFetchKey])

  function retryMember(sourceDocumentId: string) {
    const member = batch.members.find((item) => item.sourceDocumentId === sourceDocumentId)
    if (member?.latestExtraction?.outcome === 'SUCCEEDED')
      loadMember(sourceDocumentId, member.latestExtraction.extractionId, new AbortController().signal)
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
      if (!state || state.status !== 'ready' || !state.editable) return current
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
      if (!state || state.status !== 'ready' || !state.editable) return current
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
      if (!state || state.status !== 'ready' || !state.editable) return current
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
        if (state.status !== 'ready' || !state.editable) continue
        const matching = state.decisions.filter(
          (decision) =>
            decision.resultPath[0] === 'records' &&
            decision.resultPath.length === column.path.length + 2 &&
            column.path.every((segment, index) => decision.resultPath[index + 2] === segment),
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

  async function saveMember(sourceDocumentId: string) {
    const state = membersRef.current.get(sourceDocumentId)
    if (!state || state.status !== 'ready' || !state.editable) return
    setMembers((current) => {
      const latest = current.get(sourceDocumentId)
      if (!latest || latest.status !== 'ready') return current
      return new Map(current).set(sourceDocumentId, { ...latest, saving: true, saveError: null })
    })
    try {
      const updated = await finalizeExtractionReview(state.attempt.extractionId, state.decisions)
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

  const dirtyMemberIds = [...members.entries()]
    .filter(([, state]) => state.status === 'ready' && state.editable && state.touched.size > 0)
    .map(([sourceDocumentId]) => sourceDocumentId)

  async function saveAll() {
    // Sequential: each finalize is a distinct research action, and a failure
    // on one Source Document must never block the rest from saving.
    for (const sourceDocumentId of dirtyMemberIds) await saveMember(sourceDocumentId)
  }

  return {
    columns,
    members,
    dirtyCount: dirtyMemberIds.length,
    setDecision,
    approveAllForMember,
    approveAll,
    approveRow,
    approveColumn,
    saveMember,
    saveAll,
    retryMember,
  }
}
