import { useMemo, useState } from 'react'
import { oneByOneQueue, reviewTallies, sampleRest, settle, settledReasons } from './reviewQueue'
import type { RailModel } from './reviewVocabulary'

/** A reason whose values changed place because of what the researcher decided: they returned to their place after
 *  enough were approved as they were (`settled`), or come first again after an edit or a rejection (`returned`). */
export type ReviewMove = { reason: string; kind: 'settled' | 'returned'; fine: number; left: number }

const EMPTY: ReadonlySet<string> = new Set()
const NONE: readonly string[] = []
const NO_MOVES: readonly ReviewMove[] = []
const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((each) => b.has(each))

/** The review sequence learns from this review alone, and only moves values: nothing is hidden, approved or dimmed.
 *  `learning` is off while a run still saves values and on a saved or read-only cut, where the sequence is as it was
 *  built: what was learned is kept, unapplied, for when it is on again. `holding` is a row open in the list: nothing
 *  changes place under it, also not when learning starts, and what was held back applies when it closes. Returns the
 *  model with the settled values marked, the values of the rest that come early (chosen once), the moves to tell the
 *  researcher about, and the way to keep a reason first whatever was approved. */
export function useReviewLearning(model: RailModel | null, learning: boolean, holding: boolean) {
  const [on, setOn] = useState(false)
  // State kept from earlier renders, adjusted while rendering: each branch makes its own condition false.
  if (on !== learning && !(learning && holding)) setOn(learning)
  const inPlace = useMemo(() => model ? oneByOneQueue(model, false) : [], [model])
  // Only a value seen still to check while the review learns can be approved in it: a decision saved before is not
  // this review's to learn from.
  const [open, setOpen] = useState(EMPTY)
  const unseen = on ? inPlace.filter(({ key, row }) => row.kind === 'to-check' && !open.has(key)) : []
  if (unseen.length > 0) setOpen(new Set([...open, ...unseen.map((item) => item.key)]))
  const tallies = useMemo(() => reviewTallies(inPlace, open), [inPlace, open])
  const [kept, setKept] = useState(EMPTY)
  const [settled, setSettled] = useState(EMPTY)
  const [returned, setReturned] = useState(EMPTY)
  const [notice, setNotice] = useState<{ reason: string; kind: ReviewMove['kind']; on: string | null } | null>(null)
  const [sampled, setSampled] = useState<readonly string[] | null>(null)
  const wanted = useMemo(() => settledReasons(tallies, kept), [tallies, kept])
  if (on && !holding && !same(settled, wanted)) {
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
  const marked = useMemo(() => model && on ? settle(model, settled) : model, [model, on, settled])
  if (on && !holding && sampled === null && marked && inPlace.length > 0) setSampled(sampleRest(oneByOneQueue(marked, false)))
  const early = on ? sampled ?? NONE : NONE
  const moves = useMemo(() => {
    if (!on) return NO_MOVES
    const said = (reasons: ReadonlySet<string>, kind: ReviewMove['kind']) => [...reasons].flatMap((reason): ReviewMove[] => {
      const tally = tallies.get(reason)
      return tally && tally.left > 0 ? [{ reason, kind, fine: tally.fine, left: tally.left }] : []
    })
    return [...said(settled, 'settled'), ...said(returned, 'returned')]
  }, [on, settled, returned, tallies])
  return {
    model: marked, sampled: early, moves,
    /** The move to say once, on the first one-by-one card shown after it: `key` is that card's value. Another card
     *  ends it, so a return to the first one does not say it again. */
    noticeOn(key: string | null): ReviewMove | null {
      if (!on || !notice || !key) return null
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
    /** The one-by-one sequence as it will be once `next` is the model read: a decision just saved moves the card on
     *  before its read arrives, and by what the review will have learned from it. */
    queueAfter(next: RailModel, prioritize: boolean) {
      const reasons = on ? settledReasons(reviewTallies(oneByOneQueue(next, false), open), kept) : EMPTY
      return oneByOneQueue(settle(next, reasons), prioritize, early)
    },
  }
}
