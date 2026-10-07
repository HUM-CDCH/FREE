import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelOperation } from '../shared/modelOperation.contract'
import { deriveSchemaProposal, type DerivedProposal } from '../shared/schemaChanges'
import { ApiRequestError, deleteModelOperation, listModelOperations } from './api'
import { requestModelKeyResend } from './auth/authenticatedFetch'
import type { SchemaEditorController } from './currentSchemaRevision'
import { planRecovery, recoveryView, type RecoveryPlan } from './modelOperationRecovery'
import type { SchemaProposalReview } from './useSchemaProposalReview'

const POLL_MS = 2_000
/** A first listing that fails is tried again with backoff: a page loaded during a brief outage still finds its work. */
const FIRST_LISTING_RETRIES_MS = [2_000, 4_000, 8_000, 16_000, 32_000] as const

export type RecoveryOptions = {
  schema: SchemaEditorController
  proposalReview: SchemaProposalReview
  /** A review or a request is under way in the panel: nothing is restored until it ends. */
  busy: boolean
  appendMessage(message: string): void
  onReopened?(proposal: DerivedProposal): void
}

const live = (operation: ModelOperation) => operation.status === 'QUEUED' || operation.status === 'RUNNING'

/**
 * What the schema panel does on load (spec, *What the schema panel does on load*): lists the scope's operations once,
 * shows and polls the running ones, saves the newest finished generation onto its base, reopens the newest unreviewed
 * proposal, and asks for a key resend once per operation that stopped for lack of a key. An operation that finishes
 * while the panel is busy is reconsidered when the panel is idle again.
 */
export function useModelOperationRecovery({ schema, proposalReview, busy, appendMessage, onReopened }: RecoveryOptions) {
  const [running, setRunning] = useState<readonly ModelOperation[]>([])
  const latest = useRef({ proposalReview, busy, appendMessage, onReopened })
  useEffect(() => {
    latest.current = { proposalReview, busy, appendMessage, onReopened }
  })
  /** Set by the recovery effect: acts on the operations that finished while the panel was busy. */
  const reconsider = useRef<(() => Promise<void>) | null>(null)
  useEffect(() => {
    if (!busy) void reconsider.current?.()
  }, [busy])

  useEffect(() => {
    const scope = schema.operationScope() // fixed at load: the operations this page found live in it
    if (!scope) return
    const abort = new AbortController()
    const watched = new Set<string>() // running at load; this tab acts on them when they settle
    const resent = new Set<string>()
    let deferred: ModelOperation[] = [] // finished while busy; acted on once idle
    let timer: ReturnType<typeof setTimeout> | undefined
    let first = true
    let firstFailures = 0

    /** Plans over `found` with the panel's current state and acts, or defers the finished ones while busy. */
    const consider = async (found: readonly ModelOperation[]): Promise<RecoveryPlan> => {
      const { proposalReview, busy, appendMessage, onReopened } = latest.current
      const view = recoveryView(schema.snapshot(), busy)
      const plan = planRecovery(found, view)
      for (const workflowId of plan.keyMissing) {
        if (resent.has(workflowId)) continue
        resent.add(workflowId)
        requestModelKeyResend() // a 200 listing never reaches authenticatedFetch's 409 hook
      }
      if (view.busy) {
        deferred = found.filter((operation) => operation.status === 'SUCCEEDED')
        return plan
      }
      deferred = []
      if (plan.saveGeneration) {
        await schema.restoreGeneration(plan.saveGeneration.template, plan.saveGeneration.baseSchemaRevisionId, plan.saveGeneration.sourceCoverage)
      } else if (plan.reopenProposal?.response?.status === 'proposed') {
        const snapshot = schema.snapshot()
        const original = snapshot.draft?.schemaNodes ?? []
        const proposal = deriveSchemaProposal(original, plan.reopenProposal.response)
        if (proposal.changes.length > 0 || proposal.issues.length > 0) {
          // The draft is clean on the base, so its nodes are the base revision's; the draft-version guard still holds.
          proposalReview.start(proposal, original, snapshot.draftVersion, plan.reopenProposal.baseSchemaRevisionId, plan.reopenProposal.workflowId)
          onReopened?.(proposal)
          appendMessage(`Reopened the proposal for “${plan.reopenProposal.instruction}”.`)
        }
      }
      return plan
    }
    reconsider.current = async () => {
      if (abort.signal.aborted || deferred.length === 0) return
      const candidates = deferred
      deferred = []
      await consider(candidates)
    }

    const act = async () => {
      let listed: ModelOperation[]
      try {
        listed = await listModelOperations(scope, abort.signal)
      } catch (error) {
        if (abort.signal.aborted) return
        // The scope is gone (deleted, or never this account's): nothing to restore, now or later.
        if (error instanceof ApiRequestError && error.status === 404) {
          watched.clear()
          setRunning([])
          return
        }
        if (first) {
          const delay = FIRST_LISTING_RETRIES_MS[firstFailures]
          firstFailures += 1
          if (delay !== undefined) timer = setTimeout(() => void act(), delay)
        } else if (watched.size > 0) {
          timer = setTimeout(() => void act(), POLL_MS)
        }
        return
      }
      if (abort.signal.aborted) return
      // On load every listed operation counts; afterwards only those that were running then. Operations this tab
      // starts later follow the live path (generate() and the save coordinator). A watched operation the listing no
      // longer returns (discarded elsewhere, or beyond the newest 20) is let go rather than polled forever.
      const found = first ? listed : listed.filter((operation) => watched.has(operation.workflowId))
      if (first) {
        for (const operation of listed) if (live(operation)) watched.add(operation.workflowId)
      } else {
        for (const workflowId of [...watched]) if (!listed.some((operation) => operation.workflowId === workflowId)) watched.delete(workflowId)
      }
      first = false
      const plan = await consider(found)
      if (abort.signal.aborted) return
      for (const operation of found) if (!live(operation)) watched.delete(operation.workflowId)
      setRunning(plan.running.filter((operation) => watched.has(operation.workflowId)))
      if (watched.size > 0) timer = setTimeout(() => void act(), POLL_MS)
    }
    void act()
    return () => {
      abort.abort()
      clearTimeout(timer)
      reconsider.current = null
    }
  }, [schema])

  const stop = useCallback((workflowId: string) => {
    // The next poll sees a stopped operation and drops its row; a cancel Studio did not confirm is said, and the row
    // stays for another Stop.
    void deleteModelOperation(workflowId).catch(() =>
      latest.current.appendMessage('The request could not be stopped on the server; it may still be running.'),
    )
  }, [])
  return { running, stop }
}
