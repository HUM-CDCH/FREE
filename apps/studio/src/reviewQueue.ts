import { isDecidable, type RailModel, type RailRecord, type RailRow } from './reviewVocabulary'

export type QueueItem = { key: string; ownerKey: string; record: RailRecord | null; row: RailRow
  /** One of the rest that comes early, among the values checked first. */
  early?: true }

/** Why a value is checked first, in the researcher's words: on its row, on its one-by-one card and in Up next. */
export type ReviewReason = {
  /** Strongest first: what FREE read off the source, then what an automatic check said. */
  rank: number
  text: string
  /** One or two words, where there is room for no more. */
  short: string
  /** What to do about it, on the one-by-one card. */
  advice: string
  /** Set where an automatic check says it: how far to trust that, said wherever the reason is. Such a check is often
   *  wrong on real documents, so it is a reason to look and never a verdict. */
  caveat?: string
}

const ORDINARY = 5
const NO_SOURCE: ReviewReason = { rank: 0, text: 'Source not found', short: 'no source', advice: 'Look for it in the document before approving.' }
const NOT_EXACT: ReviewReason = { rank: 1, text: 'Not an exact match', short: 'not exact', advice: 'Read the marked passage closely.' }
const READINGS: ReviewReason = { rank: 2, text: 'Different readings in the source', short: 'readings', advice: 'Pick one below, or edit.' }
const UNSUPPORTED: ReviewReason = { rank: 3, text: 'The source may not support it', short: 'auto-check',
  advice: 'From an automatic check. Often wrong on real documents.', caveat: 'automatic check, often wrong' }
const DISAGREE: ReviewReason = { rank: 4, text: 'Automatic checks disagree', short: 'checks differ',
  advice: 'Two checks gave opposite answers. Read the passage yourself.', caveat: 'two gave opposite answers' }

/** The reason a value asks to be checked first, or none. A check that failed, could not run or never ran gives none:
 *  no verdict is not a verdict against the value, so it keeps its document place, as a supported one does. It reads the
 *  extracted value's reason, which a decision leaves as it was, so deciding a value never moves it. */
export function reviewReason(row: RailRow): ReviewReason | null {
  if (row.reason === 'Source not found' && !row.disagreement && (row.value === null || typeof row.value !== 'object')) return NO_SOURCE
  // Different readings are a fact to act on, so they outrank a link's doubt: that reason can settle, this one never.
  if (row.disagreement) return READINGS
  if (row.reason === 'Not an exact match' || row.doubt) return NOT_EXACT
  if (row.reason) return { ...READINGS, text: row.reason, short: row.reason.toLowerCase(), advice: '' }
  if (row.priority === 'unsupported') return UNSUPPORTED
  if (row.priority === 'uncertain') return DISAGREE
  return null
}

export const checkReason = (row: RailRow) => reviewReason(row)?.text ?? null
/** The reason as a row says it: an automatic check's with how far to trust it. */
export const rowReason = (row: RailRow) => {
  const reason = reviewReason(row)
  return reason && (reason.caveat ? `${reason.text} · ${reason.caveat}` : reason.text)
}
/** Whether the value comes first now: it has a reason, and this review has not shown that reason to be noise. */
export const checkFirst = (row: RailRow) => !row.settled && reviewReason(row) !== null
const checkRank = (row: RailRow) => checkFirst(row) ? reviewReason(row)!.rank : ORDINARY

export const hasPriority = (items: readonly QueueItem[]) => items.some(({ row }) => checkFirst(row))

/** One of the rest comes after every this many values with a reason. */
const SAMPLE_EVERY = 3
/** The values of the rest that come early, so the review shows how the rest reads while it goes and not only at its
 *  end: whole values still to check with no reason, spread over the document. Chosen once and kept, so the sequence
 *  never reshuffles under the researcher. */
export function sampleRest(items: readonly QueueItem[]) {
  const first = items.filter(({ row }) => checkFirst(row))
  const alreadyChecked = new Set(first.filter(({ row }) => row.kind !== 'to-check').map(({ key }) => key))
  const whole = items.filter(({ key, ownerKey, row }) => key === ownerKey && row.kind === 'to-check' && !reviewReason(row))
  const count = Math.min(Math.floor((first.length - alreadyChecked.size) / SAMPLE_EVERY), whole.length)
  const keys = Array.from({ length: count }, (_, slot) => whole[Math.floor((slot + 0.5) * whole.length / count)]!.key)
  return { keys, alreadyChecked }
}

/** Queue reviewable scalars once. An unresolved disagreement and a value with no populated parts stay whole.
 *  Prioritized, the values with a reason come first, strongest reason first, each kind in document order; with
 *  `sampled`, one of the rest follows every third priority value that was pending when sampling began. */
export function oneByOneQueue(model: RailModel, prioritize = true, sampled?: ReturnType<typeof sampleRest>,
  decisions?: ReadonlyMap<string, RailRow['kind']>): QueueItem[] {
  const queue: QueueItem[] = []
  const seen = new Set<string>()
  const append = (rows: readonly RailRow[], record: RailRecord | null) => {
    for (const owner of rows) {
      if (!isDecidable(owner.kind)) continue
      // A save response can arrive ahead of the page. Its decision informs navigation while the read catches up.
      const kind = decisions?.get(owner.key)
      for (const row of owner.parts?.length ? owner.parts : [owner]) {
        if (seen.has(row.key)) continue
        seen.add(row.key)
        queue.push({ key: row.key, ownerKey: owner.key, record, row: kind ? { ...row, kind } : row })
      }
    }
  }
  append(model.document, null)
  const records = [...model.records].sort((first, second) => first.index - second.index)
  for (const record of records) {
    if (record.state === 'finished') append(record.rows, record)
  }
  if (!prioritize) return queue
  const first = queue.filter(({ row }) => checkFirst(row)).sort((a, b) => checkRank(a.row) - checkRank(b.row))
  const rest = queue.filter(({ row }) => !checkFirst(row))
  if (!sampled?.keys.length) return [...first, ...rest]
  const byKey = new Map(rest.map((item) => [item.key, item]))
  const picked = sampled.keys.flatMap((key) => byKey.get(key) ?? [])
  const taken = new Set<string>()
  const sequence: QueueItem[] = []
  let eligible = 0
  for (const item of first) {
    sequence.push(item)
    if (sampled.alreadyChecked.has(item.key)) continue
    eligible++
    const pick = eligible % SAMPLE_EVERY === 0 ? picked[eligible / SAMPLE_EVERY - 1] : undefined
    if (pick) {
      sequence.push({ ...pick, early: true })
      taken.add(pick.key)
    }
  }
  return [...sequence, ...rest.filter((item) => !taken.has(item.key))]
}

export type ReasonTally = { fine: number; wrong: number; left: number }
/** What the researcher's decisions in this review say of each reason ('' is no reason: the rest): values approved as
 *  they were, values edited or rejected, values still to check. Whole values are counted, never a table's cells apart:
 *  a table with any cell still to check is no approval yet. With `here`, the values seen still to check in this
 *  review, an approval made before it is none either; an edit or a rejection counts whenever it was made. */
export function reviewTallies(items: readonly QueueItem[], here?: ReadonlySet<string>): Map<string, ReasonTally> {
  // What a whole value says is the most that any of its parts does.
  const FINE = 0, BEFORE = 1, LEFT = 2, WRONG = 3
  const whole = new Map<string, number>()
  const seen = new Map<string, { owners: Set<string>; left: number }>()
  for (const { key, row, ownerKey } of items) {
    const says = row.kind === 'approved' ? (here && !here.has(key) ? BEFORE : FINE)
      : row.kind === 'to-check' ? LEFT : row.kind === 'edited' || row.kind === 'rejected' ? WRONG : null
    if (says === null) continue
    whole.set(ownerKey, Math.max(whole.get(ownerKey) ?? FINE, says))
    for (const reason of row.partReasons?.length ? row.partReasons : [checkReason(row) ?? '']) {
      const tally = seen.get(reason) ?? { owners: new Set<string>(), left: 0 }
      tally.owners.add(ownerKey)
      if (says === LEFT) tally.left += 1
      seen.set(reason, tally)
    }
  }
  const count = (owners: ReadonlySet<string>, says: number) => [...owners].filter((owner) => whole.get(owner) === says).length
  return new Map([...seen].map(([reason, tally]) => [reason, { fine: count(tally.owners, FINE), wrong: count(tally.owners, WRONG), left: tally.left }]))
}

/** Values decided with a reason before the review trusts what they showed. */
export const LEARN_AFTER = 3
/** The reasons this review has shown to be noise: enough values decided with one, every one approved as it was, and
 *  none of the rest edited or rejected either. Their remaining values return to their place; an edit or a rejection of
 *  one, or of one of the rest, brings them first again. Only a soft reason can settle: no source and different readings
 *  are facts the researcher must act on, and `kept` are the reasons the researcher asked to keep first.
 *  shortcut: three is a placeholder, no review decisions exist yet to set it from; calibrate when they do. */
export function settledReasons(tallies: ReadonlyMap<string, ReasonTally>, kept: ReadonlySet<string>): Set<string> {
  if ((tallies.get('')?.wrong ?? 0) > 0) return new Set()
  return new Set([NOT_EXACT, UNSUPPORTED, DISAGREE].map((reason) => reason.text).filter((reason) => {
    const tally = tallies.get(reason)
    return tally !== undefined && !kept.has(reason) && tally.wrong === 0 && tally.fine >= LEARN_AFTER
  }))
}

/** Marks the values whose reason no longer comes first in this review. The reason itself stays on the value. */
export function settle(model: RailModel, settled: ReadonlySet<string>): RailModel {
  if (settled.size === 0) return model
  const mark = (row: RailRow): RailRow => {
    const parts = row.parts?.map(mark)
    return { ...row, ...(parts ? { parts } : {}), ...(settled.has(checkReason(row) ?? '') ? { settled: true } : {}) }
  }
  return { ...model, document: model.document.map(mark), records: model.records.map((record) => ({ ...record, rows: record.rows.map(mark) })) }
}

/** Keep acknowledged writes as navigation anchors while waiting for the saved decision. */
export function forwardItems(
  queue: readonly QueueItem[], current: string | null, blocked: ReadonlySet<string> = new Set(),
): QueueItem[] {
  const at = queue.findIndex((item) => item.key === current)
  const around = at < 0 ? queue : [...queue.slice(at + 1), ...queue.slice(0, at)]
  return around.filter((item) => item.row.kind === 'to-check' && !blocked.has(item.ownerKey))
}

/** J, Skip and save advancement all take the first eligible value; the current one is postponed. */
export function nextToCheck(
  queue: readonly QueueItem[], current: string | null, blocked?: ReadonlySet<string>,
): string | null {
  return forwardItems(queue, current, blocked)[0]?.key ?? null
}

export function previousInQueue(queue: readonly QueueItem[], current: string): string {
  const at = queue.findIndex((item) => item.key === current)
  return at < 0 ? current : queue[(at - 1 + queue.length) % queue.length]!.key
}

export function queuePosition(queue: readonly QueueItem[], current: string) {
  const index = queue.findIndex((each) => each.key === current)
  if (index < 0) return null
  const { record, row } = queue[index]!
  return { at: index + 1, of: queue.length, row, items: queue.filter((each) => each.record === record) }
}
