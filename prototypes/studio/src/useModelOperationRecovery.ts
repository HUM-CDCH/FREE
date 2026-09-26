import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelOperation } from '../shared/modelOperation.contract'
import { deriveSchemaProposal, type DerivedProposal } from '../shared/schemaChanges'
import { deleteModelOperation, listModelOperations } from './api'
import { requestModelKeyResend } from './auth/authenticatedFetch'
import type { SchemaEditorController } from './currentSchemaRevision'
import { planRecovery, recoveryView } from './modelOperationRecovery'
import type { SchemaProposalReview } from './useSchemaProposalReview'

const POLL_MS = 2_000

export type RecoveryOptions = {
  schema: SchemaEditorController
  proposalReview: SchemaProposalReview
  /** A review or a request is under way in the panel: nothing is restored until it ends. */
  busy: boolean
  appendMessage(message: string): void
  onReopened?(proposal: DerivedProposal): void
}

/**
 * What the schema panel does on load (spec, *What the schema panel does on load*): lists the scope's operations once,
 * shows and polls the running ones, saves the newest finished generation onto its base, reopens the newest unreviewed
 * proposal, and asks for a key resend once per operation that stopped for lack of a key.
 */
export function useModelOperationRecovery({ schema, proposalReview, busy, appendMessage, onReopened }: RecoveryOptions) {
  const [running, setRunning] = useState<readonly ModelOperation[]>([])
  const latest = useRef({ proposalReview, busy, appendMessage, onReopened })
  useEffect(() => {
    latest.current = { proposalReview, busy, appendMessage, onReopened }
  })
  useEffect(() => {
    const scope = schema.operationScope() // fixed at load: the operations this page found live in it
    if (!scope) return
    const abort = new AbortController()
    const watched = new Set<string>() // running at load; this tab acts on them when they settle
    const resent = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let first = true
    const act = async () => {
      let listed: ModelOperation[]
      try {
        listed = await listModelOperations(scope, abort.signal)
      } catch {
        if (!abort.signal.aborted && watched.size > 0) timer = setTimeout(() => void act(), POLL_MS)
        return
      }
      if (abort.signal.aborted) return
      // On load every listed operation counts; afterwards only those that were running then. Operations this tab
      // starts later follow the live path (generate() and the save coordinator).
      const found = first ? listed : listed.filter((operation) => watched.has(operation.workflowId))
      if (first) for (const operation of listed) if (operation.status === 'QUEUED' || operation.status === 'RUNNING') watched.add(operation.workflowId)
      first = false
      const { proposalReview, busy, appendMessage, onReopened } = latest.current
      const plan = planRecovery(found, recoveryView(schema.snapshot(), busy))
      for (const workflowId of plan.keyMissing) {
        if (resent.has(workflowId)) continue
        resent.add(workflowId)
        requestModelKeyResend() // a 200 listing never reaches authenticatedFetch's 409 hook
      }
      if (plan.saveGeneration) {
        await schema.restoreGeneration(plan.saveGeneration.template, plan.saveGeneration.baseSchemaRevisionId)
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
      if (abort.signal.aborted) return
      for (const operation of found) if (operation.status !== 'QUEUED' && operation.status !== 'RUNNING') watched.delete(operation.workflowId)
      setRunning(plan.running.filter((operation) => watched.has(operation.workflowId)))
      if (watched.size > 0) timer = setTimeout(() => void act(), POLL_MS)
    }
    void act()
    return () => {
      abort.abort()
      clearTimeout(timer)
    }
  }, [schema])
  const stop = useCallback((workflowId: string) => {
    void deleteModelOperation(workflowId).catch(() => undefined) // the next poll sees it stopped and drops it
  }, [])
  return { running, stop }
}
