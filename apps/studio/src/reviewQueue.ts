import { isDecidable, type RailModel, type RailRow } from './reviewVocabulary'

/** One value of the one-by-one queue (results review redesign §4.2). */
export type QueueItem = { key: string; record: number; row: RailRow }

/**
 * Every decidable value of every readable record, by record in list order, then doubtful links first, then schema
 * order. Recomputed from the model on every change: a decision changes its row, an undo restores it, a record read
 * during the run appends its values, settlement adds what it changed.
 */
export function reviewQueue(model: RailModel): QueueItem[] {
  return model.records.filter((record) => record.state === 'finished').flatMap((record) => {
    const rows = record.rows.filter((row) => isDecidable(row.kind))
    return [...rows.filter((row) => row.doubt !== null), ...rows.filter((row) => row.doubt === null)]
      .map((row) => ({ key: row.key, record: record.index, row }))
  })
}

const open = (item: QueueItem) => item.row.kind === 'to-check'

/** The next undecided value after `current` (J, or after a decision): wrapping within its record, then the next record
 *  with one. Null when no other value is to check; skipping postpones the current one, which comes back last. */
export function nextToCheck(queue: readonly QueueItem[], current: string | null): string | null {
  const at = queue.findIndex((item) => item.key === current)
  if (at < 0) return queue.find(open)?.key ?? null
  const record = queue[at]!.record
  const inRecord = queue.filter((item) => item.record === record)
  const position = inRecord.findIndex((item) => item.key === current)
  const around = [...inRecord.slice(position + 1), ...inRecord.slice(0, position)]
  const after = [...queue.slice(at + 1), ...queue.slice(0, at)].filter((item) => item.record !== record)
  return [...around, ...after].find(open)?.key ?? null
}

/** The previous value in the current record's queue, decided or not (K), wrapping within the record. */
export function previousInRecord(queue: readonly QueueItem[], current: string): string {
  const at = queue.findIndex((item) => item.key === current)
  if (at < 0) return current
  const inRecord = queue.filter((item) => item.record === queue[at]!.record)
  const position = inRecord.findIndex((item) => item.key === current)
  return inRecord[(position - 1 + inRecord.length) % inRecord.length]!.key
}

/** Where the current value stands: "Record {i} of {m} · {j} of {k} in this record" (§4.2). */
export function queuePosition(queue: readonly QueueItem[], current: string) {
  const item = queue.find((each) => each.key === current)
  if (!item) return null
  const records = [...new Set(queue.map((each) => each.record))]
  const inRecord = queue.filter((each) => each.record === item.record)
  return { record: records.indexOf(item.record) + 1, records: records.length, at: inRecord.indexOf(item) + 1, of: inRecord.length, items: inRecord }
}
