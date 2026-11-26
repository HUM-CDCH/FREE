import { useCallback, useEffect, useRef, useState } from 'react'
import { deleteModelOperation, requestResultCorrections } from './api'
import { durableRequest, durableRoot } from './durableExtractionApi'
import type { ChatHistory, ChatView } from '../shared/schemaChat.contract'
import type { ResultCorrectionProposal } from '../shared/resultCorrection.contract'

/** The result a chat message corrects: the Extraction Results shows, at the snapshot it shows (null: its latest). */
export type CorrectionTarget = { extractionId: string; snapshotVersion: number | null }

/** The reply to a request to change results where there are none to change. */
export const NO_RESULTS_REPLY = 'This document has no results to change yet: extract it first, then say which values to change.'
const NOTHING_PROPOSED_REPLY = 'I could not tell which values to change: name the record and field, and the value they should hold.'

export type ResultCorrections = {
  /** The proposal waiting for the researcher, with the request it answers (each its own number). */
  readonly pending: { request: number; proposal: ResultCorrectionProposal } | null
  /** A proposal is being asked for, or saved. */
  readonly busy: 'proposing' | 'saving' | null
  /** `view` is where the message was said (ADR 0043). */
  propose(message: string, history: ChatHistory, view?: ChatView | null): Promise<void>
  /** Saves every proposed change as the researcher's correction of its value, as Results' own save does. */
  save(): Promise<void>
  discard(): void
  /** Stops a proposal being asked for. */
  stop(): void
  /** Results shows a result a message can change (ADR 0035). */
  readonly available?: boolean
  /** What the values could not meet but the template already holds, offered as a new run (ADR 0042): why, with the
   *  request it answers. Held until the researcher chooses, another proposal is asked for, or another result shows. */
  readonly rerun?: { request: number; reason: string } | null
  dismissRerun?(): void
}

/**
 * The chat's corrections of the result Results shows (ADR 0035): a message's proposed changes, held until the
 * researcher saves or discards them. Saving goes through the correction save of Results, one value at a time, with the
 * revision the proposal read; a change that a newer correction overtook is refused and said, and the others stay saved.
 * A saved edit guides later Extractions in the project as an edit made in Results does: only the value the researcher
 * saved, never the conversation or the model's reasons.
 */
export function useResultCorrections({ target, say, onSaved, onTemplateChange }: {
  target: CorrectionTarget | null
  /** Says something in the conversation, as the assistant. */
  say: (message: string) => void
  /** Reads the result again once corrections are saved. */
  onSaved: () => void
  /** Proposes the template change a request needs beyond the values it changes (ADR 0037), with the conversation
   *  through the request. */
  onTemplateChange?: (instruction: string, history: ChatHistory) => void
}): ResultCorrections {
  const [pending, setPending] = useState<ResultCorrections['pending']>(null)
  const [busy, setBusy] = useState<ResultCorrections['busy']>(null)
  const [rerun, setRerun] = useState<ResultCorrections['rerun']>(null)
  const requests = useRef(0)
  const abortRef = useRef<{ controller: AbortController; operationId: string } | null>(null)
  useEffect(() => () => abortRef.current?.controller.abort(), [])
  // A proposal is for the result it was read from: another Extraction shown ends it.
  const extractionId = target?.extractionId ?? null
  const [proposedFor, setProposedFor] = useState(extractionId)
  if (proposedFor !== extractionId) {
    setProposedFor(extractionId)
    setPending(null)
    setRerun(null)
  }

  const propose = useCallback(async (message: string, history: ChatHistory, view: ChatView | null = null) => {
    if (!target) { say(NO_RESULTS_REPLY); return }
    abortRef.current?.controller.abort()
    const controller = new AbortController()
    const operationId = crypto.randomUUID()
    abortRef.current = { controller, operationId }
    setPending(null)
    setRerun(null)
    setBusy('proposing')
    try {
      const proposal = await requestResultCorrections(target, message, controller.signal, operationId, history, view)
      if (abortRef.current?.controller !== controller) return
      const notes = proposal.dropped.length ? `\n\nLeft out: ${proposal.dropped.join(' ')}` : ''
      const templateChange = onTemplateChange ? proposal.templateChange ?? null : null
      const again = templateChange ? null : proposal.rerun ?? null
      if (proposal.corrections.length === 0 && !templateChange && !again) say(`${proposal.reply ?? NOTHING_PROPOSED_REPLY}${notes}`)
      else {
        if (proposal.reply || notes) say(`${proposal.reply ?? ''}${notes}`.trim())
        if (proposal.corrections.length > 0) setPending({ request: requests.current += 1, proposal })
      }
      // What the values cannot meet but the template already holds is offered as a new run, after the changes.
      if (again) setRerun({ request: requests.current += 1, reason: again })
      // What the template cannot hold is proposed as a template change, after any changes to the values themselves.
      if (templateChange) onTemplateChange!(templateChange, [...history, { role: 'user', text: message }])
    } catch (err) {
      if (abortRef.current?.controller !== controller) return
      if (!(typeof err === 'object' && err !== null && 'name' in err && err.name === 'AbortError'))
        say(`Request failed: ${err instanceof Error ? err.message : 'the changes could not be proposed.'}`)
    } finally {
      if (abortRef.current?.controller === controller) {
        abortRef.current = null
        setBusy(null)
      }
    }
  }, [onTemplateChange, say, target])

  const save = useCallback(async () => {
    if (!pending || busy) return
    const { proposal } = pending
    setBusy('saving')
    const failed: string[] = []
    for (const correction of proposal.corrections) {
      try {
        await durableRequest(`${durableRoot(proposal.extractionId)}/values/${encodeURIComponent(correction.valueId)}`, {
          expectedRevision: correction.expectedRevision,
          snapshotVersion: proposal.snapshotVersion,
          action: correction.action,
          ...(correction.action === 'EDITED' ? { value: correction.value } : {}),
          evidence: [],
          included: true,
        })
      } catch (err) {
        failed.push(`${correction.label}: ${err instanceof Error ? err.message : 'not saved'}`)
      }
    }
    const saved = proposal.corrections.length - failed.length
    setBusy(null)
    setPending(null)
    if (saved > 0) onSaved()
    say(failed.length === 0
      ? `Saved ${saved === 1 ? 'the change' : `${saved} changes`} to the results.`
      : `Saved ${saved} of ${proposal.corrections.length} changes. Not saved: ${failed.join(' ')}`)
  }, [busy, onSaved, pending, say])

  const discard = useCallback(() => { setPending(null) }, [])
  const dismissRerun = useCallback(() => { setRerun(null) }, [])
  const stop = useCallback(() => {
    const running = abortRef.current
    if (!running) return
    abortRef.current = null
    setBusy(null)
    void deleteModelOperation(`correct:${running.operationId}`).catch(() => {})
    running.controller.abort()
  }, [])

  return { pending, busy, propose, save, discard, stop, available: target !== null, rerun, dismissRerun }
}
