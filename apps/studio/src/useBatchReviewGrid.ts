import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DurablePage } from 'extraction/durable-types'
import { reviewableMember, type BatchExtraction, type BatchExtractionMember } from '../shared/batchExtraction.contract'
import { durableRequest, durableRoot, readDurable } from './durableExtractionApi'
import { decisionBody, finalizable, type GridAction, type GridValue } from './batchReviewGrid'

export type MemberGridState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; page: DurablePage; saving: boolean; error: string | null }

/** One decision the grid saves: a value of a member, at that member's shown results. */
export type GridDecision = { extractionId: string; value: GridValue; action: GridAction; edited?: unknown }

/** At most this many members are read, or saved to, at once. */
const CONCURRENCY = 4

/** Runs `work` over `items`, at most `limit` at a time. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!)
  }))
}

const NONE: ReadonlySet<string> = new Set()

const failureText = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

/** A member with saved values joins the grid once its run completed or settled (a member stopped or failed partway
 *  included), as the document's Results and the chat review it: a running one's values still change. */
export const gridMember = (member: BatchExtractionMember) => reviewableMember(member)

/**
 * The grid's view of a batch: each completed member's latest saved results, read once and again after a decision on
 * it. A decision saves at once, as a revisioned correction of one value, as the document's review does; finalizing
 * names one member's shown results and Decision Version.
 */
export function useBatchReviewGrid(batch: BatchExtraction, onFinalized?: () => void,
  superseded: ReadonlySet<string> = NONE) {
  const [read, setMembers] = useState<ReadonlyMap<string, MemberGridState>>(new Map())
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const update = useCallback((id: string, next: (previous: MemberGridState | undefined) => MemberGridState) => {
    if (mounted.current) setMembers((current) => new Map(current).set(id, next(current.get(id))))
  }, [])

  /** Reads one member's latest results; a failed read of a member already shown keeps it and says why. */
  const load = useCallback(async (id: string, signal?: AbortSignal) => {
    try {
      const { page, pageError } = await readDurable(id, signal)
      if (pageError) throw pageError
      if (!page) throw new Error('The saved results could not be read.')
      if (!signal?.aborted) update(id, (previous) => ({ status: 'ready', page, saving: false,
        error: previous?.status === 'ready' ? previous.error : null }))
    } catch (error) {
      if (signal?.aborted) return
      const message = failureText(error, 'The saved results could not be read.')
      update(id, (previous) => previous?.status === 'ready' ? { ...previous, saving: false, error: message } : { status: 'error', message })
    }
  }, [update])

  // A member is read again when the batch says it changed: its run's status (a resumed one may save more), or finalized
  // elsewhere. The grid holds the batch's reviewable members only, each shown as loading until its first read.
  // A member whose document has a newer run is that run's to review, not the grid's: it is not read.
  const eligible = batch.members.filter((member) => gridMember(member) && !superseded.has(member.extractionId))
  const memberKey = JSON.stringify(eligible.map((member) => [member.extractionId, member.currentReview, member.executionStatus]))
  useEffect(() => {
    const controller = new AbortController()
    const ids = (JSON.parse(memberKey) as [string, unknown][]).map(([id]) => id)
    void pool(ids, CONCURRENCY, (id) => load(id, controller.signal))
    return () => controller.abort()
  }, [memberKey, load])
  const members = useMemo<ReadonlyMap<string, MemberGridState>>(() => new Map(
    (JSON.parse(memberKey) as [string, unknown][]).map(([id]) => [id, read.get(id) ?? { status: 'loading' }])), [memberKey, read])

  const setSaving = (ids: Iterable<string>) => {
    for (const id of ids) update(id, (previous) => previous?.status === 'ready' ? { ...previous, saving: true, error: null } : previous!)
  }

  /** Saves decisions, one member's in order and at most CONCURRENCY members at once, then reads each member again. A
   *  refused decision (a conflict, a value that changed) stops that member's and is said on its row. */
  const decide = useCallback(async (decisions: readonly GridDecision[]) => {
    const byMember = new Map<string, GridDecision[]>()
    for (const decision of decisions) byMember.set(decision.extractionId, [...byMember.get(decision.extractionId) ?? [], decision])
    setSaving(byMember.keys())
    await pool([...byMember], CONCURRENCY, async ([id, own]) => {
      const state = members.get(id)
      if (state?.status !== 'ready') return
      let failure: string | null = null
      for (const { value, action, edited } of own) {
        try {
          await durableRequest(`${durableRoot(id)}/values/${encodeURIComponent(value.id)}`,
            decisionBody(value, state.page.snapshotVersion, action, edited))
        } catch (error) { failure = failureText(error, 'Unable to save the decision.'); break }
      }
      await load(id)
      if (failure) update(id, (previous) => previous?.status === 'ready' ? { ...previous, error: failure } : previous!)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `members` is read when a decision starts
  }, [members, load, update])

  /** Finalizes one member's shown results and Decision Version: an explicit action on that named pair. */
  const finalize = useCallback(async (id: string) => {
    const state = members.get(id)
    if (state?.status !== 'ready' || !finalizable(state.page)) return
    setSaving([id])
    try {
      await durableRequest(`${durableRoot(id)}/finalize`, { snapshotVersion: state.page.snapshotVersion, feedbackVersion: state.page.feedbackVersion })
      await load(id)
      onFinalized?.()
    } catch (error) {
      const message = failureText(error, 'Unable to save the review.')
      await load(id)
      update(id, (previous) => previous?.status === 'ready' ? { ...previous, error: message } : previous!)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `members` is read when finalizing starts
  }, [members, load, update, onFinalized])

  const retry = useCallback((id: string) => {
    update(id, (previous) => previous?.status === 'ready' ? previous : { status: 'loading' })
    void load(id)
  }, [load, update])

  const pages = useMemo(() => [...members.values()].flatMap((state) => state.status === 'ready' ? [state.page] : []), [members])
  return { members, pages, decide, finalize, retry }
}
