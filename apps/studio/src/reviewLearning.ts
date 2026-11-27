import { useMemo, useState } from 'react'
import { checkFirst, forwardItems, oneByOneQueue, reviewTallies, sampleRest, settle, settledReasons, type QueueItem } from './reviewQueue'
import type { RailModel, RowKind } from './reviewVocabulary'

/** A reason whose values changed place because of what the researcher decided: they returned to their place after
 *  enough were approved as they were (`settled`), or come first again after an edit or a rejection (`returned`). */
export type ReviewMove = { reason: string; kind: 'settled' | 'returned'; fine: number; left: number }

const EMPTY: ReadonlySet<string> = new Set()
const NO_DECISIONS: ReadonlyMap<string, RowKind> = new Map()

const NO_MOVES: readonly ReviewMove[] = []
const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((each) => b.has(each))

/** The review sequence learns from this review alone, and only moves values: nothing is hidden, approved or dimmed.
 *  `learning` is off while a run still saves values and on a saved or read-only cut, where the sequence is as it was
 *  built: what was learned is kept, unapplied, for when it is on again. `holding` is a row open in the list, a save
 *  in flight, or a page behind state: nothing changes place under it, also not when learning starts, and what was held
 *  back applies when it clears. `live` is a model of this review's own decisions, not an opened cut's: there an
 *  approval undone or replaced while learning is off stops counting, also when it is approved again. Returns the model with the settled values marked, the values of the rest that come
 *  early (chosen once), the moves to tell the researcher about, the settled reasons, and the way to keep a reason
 *  first whatever was approved. */
export function useReviewLearning(model: RailModel | null, learning: boolean, holding: boolean, live: boolean, decisions = NO_DECISIONS) {
  const [on, setOn] = useState(false)
  // Effective policy for this render: holding keeps an active session from starting under an open row or stale page,
  // while leaving learning immediately drops learning so historical/inactive renders never record `open`.
  const active = learning && (!holding || on)
  if (on !== active) setOn(active)
  const inPlace = useMemo(() => model ? oneByOneQueue(model, false, undefined, decisions) : [], [model, decisions])
  // Separate currently-open keys (`to-check` in this active interval) from already-earned approvals (observed
  // transitioning from `open` to `approved` while `active`). Leaving active learning clears `open` so approvals
  // made while a run saves values or in a saved cut never become earned when active learning resumes, while keeping
  // valid prior learning in `earned`: an opened cut never touches it, a live decision no longer approved drops it.
  const [open, setOpen] = useState(EMPTY)
  const [earned, setEarned] = useState(EMPTY)
  const { nextOpen, nextEarned } = useMemo(() => {
    if (!active) {
      if (!live || earned.size === 0) return { nextOpen: EMPTY, nextEarned: earned }
      const revoked = new Set(inPlace.filter(({ row }) => row.kind !== 'approved').map(({ key }) => key))
      const stillEarned = new Set([...earned].filter((key) => !revoked.has(key)))
      return { nextOpen: EMPTY, nextEarned: same(earned, stillEarned) ? earned : stillEarned }
    }
    if (!model) return { nextOpen: open, nextEarned: earned }
    const toCheck = new Set<string>()
    const approved = new Set<string>()
    for (const { key, row } of inPlace) {
      if (row.kind === 'to-check') toCheck.add(key)
      else if (row.kind === 'approved') approved.add(key)
    }
    const updatedEarned = new Set<string>()
    for (const key of earned) if (approved.has(key)) updatedEarned.add(key)
    for (const key of approved) if (open.has(key)) updatedEarned.add(key)
    return {
      nextOpen: same(open, toCheck) ? open : toCheck,
      nextEarned: same(earned, updatedEarned) ? earned : updatedEarned,
    }
  }, [active, live, model, inPlace, open, earned])
  if (nextOpen !== open) setOpen(nextOpen)
  if (nextEarned !== earned) setEarned(nextEarned)
  const eligible = useMemo(
    () => nextOpen.size === 0 ? nextEarned : nextEarned.size === 0 ? nextOpen : new Set([...nextEarned, ...nextOpen]),
    [nextEarned, nextOpen],
  )
  const tallies = useMemo(() => reviewTallies(inPlace, eligible), [inPlace, eligible])
  const [kept, setKept] = useState(EMPTY)
  const [settled, setSettled] = useState(EMPTY)
  const [returned, setReturned] = useState(EMPTY)
  const [notice, setNotice] = useState<{ reason: string; kind: ReviewMove['kind']; on: string | null } | null>(null)
  const [sampled, setSampled] = useState<ReturnType<typeof sampleRest>>()
  const wanted = useMemo(() => settledReasons(tallies, kept), [tallies, kept])
  if (active && !holding && !same(settled, wanted)) {
    const left = (reason: string) => (tallies.get(reason)?.left ?? 0) > 0
    // Only an edit or a rejection is said to bring a kind back: an approval undone brings it back unsaid.
    const wrong = (reason: string) => (tallies.get('')?.wrong ?? 0) + (tallies.get(reason)?.wrong ?? 0) > 0
    const come = [...wanted].filter((reason) => !settled.has(reason))
    const gone = [...settled].filter((reason) => !wanted.has(reason) && !kept.has(reason) && wrong(reason))
    setSettled(wanted)
    setReturned(new Set([...returned, ...gone].filter((reason) => !wanted.has(reason))))
    const moved = come.find(left) ?? gone.find(left)
    if (moved) setNotice({ reason: moved, kind: come.includes(moved) ? 'settled' : 'returned', on: null })
  }
  const marked = useMemo(() => model && active ? settle(model, settled) : model, [model, active, settled])
  if (active && !holding && sampled === undefined && inPlace.length > 0) setSampled(sampleRest(inPlace))
  const early = active ? sampled : undefined
  const moves = useMemo(() => {
    if (!active) return NO_MOVES
    const said = (reasons: ReadonlySet<string>, kind: ReviewMove['kind']) => [...reasons].flatMap((reason): ReviewMove[] => {
      const tally = tallies.get(reason)
      return tally && tally.left > 0 ? [{ reason, kind, fine: tally.fine, left: tally.left }] : []
    })
    return [...said(settled, 'settled'), ...said(returned, 'returned')]
  }, [active, settled, returned, tallies])
  return {
    model: marked, sampled: early, moves, settled: active ? settled : EMPTY,
    /** The move to say once, on the first one-by-one card shown after it: `key` is that card's value. Another card
     *  ends it, so a return to the first one does not say it again. */
    noticeOn(key: string | null): ReviewMove | null {
      if (!active || !notice || !key) return null
      if (notice.on === null) setNotice({ ...notice, on: key })
      else if (notice.on !== key) { setNotice(null); return null }
      return moves.find((move) => move.reason === notice.reason && move.kind === notice.kind) ?? null
    },
    /** The researcher's own word: values with this reason come first whatever was approved. */
    keep(reason: string) {
      setKept(new Set([...kept, reason]))
      setReturned(new Set([...returned].filter((each) => each !== reason)))
      setNotice(null)
    },
    /** The next value to check once `next` is the model read: a decision just saved moves the card on before its read
     *  arrives, and by what the review will have learned from it. When the decision changes which reasons come first
     *  (compared against `beforeSettled` if provided, so a poll landing mid-save cannot mask the transition),
     *  advance into the new priority sequence so remaining or returned issues are not postponed behind the rest. */
    nextAfter(
      next: RailModel,
      prioritize: boolean,
      current: string | null,
      blocked: ReadonlySet<string> = EMPTY,
      exclude?: (item: QueueItem) => boolean,
      beforeSettled?: ReadonlySet<string>,
      confirmed = decisions,
    ): string | null {
      const currentSettled = active ? (beforeSettled ?? settled) : EMPTY
      const reasons = active ? settledReasons(reviewTallies(oneByOneQueue(next, false, undefined, confirmed), eligible), kept) : EMPTY
      const after = oneByOneQueue(settle(next, reasons), prioritize, early, confirmed)
      const canTake = (item: QueueItem) => item.row.kind === 'to-check' && !blocked.has(item.ownerKey) && !exclude?.(item)
      if (prioritize && !same(currentSettled, reasons)) {
        const priority = after.find((item) => checkFirst(item.row) && canTake(item))
        if (priority) return priority.key
      }
      return forwardItems(after, current, blocked).find((item) => !exclude?.(item))?.key ?? null
    },
  }
}
