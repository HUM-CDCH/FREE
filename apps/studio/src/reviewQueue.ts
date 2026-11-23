import { isDecidable, type RailModel, type RailRecord, type RailRow } from './reviewVocabulary'

export type QueueItem = { key: string; ownerKey: string; record: RailRecord | null; row: RailRow }

const ORDINARY = 3

function checkCue(row: RailRow): { rank: number; text: string } | null {
  if (!row.link && row.reason && !row.disagreement && (row.value === null || typeof row.value !== 'object')) {
    return { rank: 0, text: row.reason }
  }
  if (row.link?.verbatim === false || row.doubt) return { rank: 1, text: 'Not an exact match' }
  if (row.disagreement) return { rank: 2, text: 'Different readings in the source' }
  if (row.reason) return { rank: 2, text: row.reason }
  if (row.priority === 'unsupported') return { rank: 2, text: 'Source may not support this value' }
  if (row.priority === 'to-verify') return { rank: 2, text: 'Support could not be checked' }
  return null
}

const checkRank = (row: RailRow) => checkCue(row)?.rank ?? ORDINARY
export const checkReason = (row: RailRow) => checkCue(row)?.text ?? null

export const hasPriority = (items: readonly QueueItem[]) =>
  items.some(({ row }) => checkCue(row) !== null)

/** Queue reviewable scalars once. An unresolved disagreement and a value with no populated parts stay whole. */
export function oneByOneQueue(model: RailModel, prioritize = true): QueueItem[] {
  const queue: QueueItem[] = []
  const seen = new Set<string>()
  const append = (rows: readonly RailRow[], record: RailRecord | null) => {
    for (const owner of rows) {
      if (!isDecidable(owner.kind)) continue
      for (const row of owner.parts?.length ? owner.parts : [owner]) {
        if (seen.has(row.key)) continue
        seen.add(row.key)
        queue.push({ key: row.key, ownerKey: owner.key, record, row })
      }
    }
  }
  append(model.document, null)
  const records = [...model.records].sort((first, second) => first.index - second.index)
  for (const record of records) {
    if (record.state === 'finished') append(record.rows, record)
  }
  return prioritize ? queue.sort((first, second) => checkRank(first.row) - checkRank(second.row)) : queue
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
  const record = queue[index]!.record
  return { at: index + 1, of: queue.length, items: queue.filter((each) => each.record === record) }
}
