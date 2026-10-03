import type { PartialRecord, PartialResult } from '../shared/extraction.contract'
import type { ValueState } from './ui'

/** Retain whole finished server snapshots through missing or regressed progress reads; settlement replaces them. */
export function retainFinished(previous: PartialResult | null, next: PartialResult | null): PartialResult | null {
  if (next === null) return previous
  if (previous === null) return next
  const finished = new Map(previous.records.filter((record) => record.state === 'finished').map((record) => [record.index, record]))
  const records = next.records.map((record) => {
    const kept = finished.get(record.index)
    if (!kept) return record
    const links = new Set(record.evidenceLinks.map((link) => JSON.stringify([link.resultPath, link.evidenceAnchorId])))
    const retainsLinks = kept.evidenceLinks.every((link) => links.has(JSON.stringify([link.resultPath, link.evidenceAnchorId])))
    return record.state === 'finished' && retainsLinks ? record : kept
  })
  // Reinsert omitted finished snapshots beside their last server-reported neighbors. Record indices
  // identify snapshots, but their numeric order does not describe the server's read order.
  const present = new Set(records.map((record) => record.index))
  const preceding = new Map<number, number | null>()
  let lastPresent: number | null = null
  for (const record of previous.records) {
    preceding.set(record.index, lastPresent)
    if (present.has(record.index)) lastPresent = record.index
  }
  let following: number | null = null
  for (let position = previous.records.length - 1; position >= 0; position -= 1) {
    const record = previous.records[position]
    if (present.has(record.index)) {
      following = record.index
      continue
    }
    if (record.state !== 'finished') continue
    const before = following === null ? -1 : records.findIndex((each) => each.index === following)
    const neighbor = preceding.get(record.index)
    const after = neighbor == null ? 0 : records.findIndex((each) => each.index === neighbor) + 1
    records.splice(before === -1 ? after : before, 0, record)
    following = record.index
  }
  return {
    ...next, records,
    // Preserve reported counters; counting the combined cache would infer progress the server never reported.
    finished: Math.max(previous.finished, next.finished),
    discovered: Math.max(previous.discovered, next.discovered),
  }
}

/** Part A owns leaf states. Missing metadata uses only Ruling 8's explicit placeholder mapping. */
export function partialValueState(record: PartialRecord, path: readonly string[]): ValueState {
  const value = record.values[JSON.stringify(path)]
  if (value) return value.state
  return record.state === 'reading' ? 'reading' : 'queued'
}

/** The Results header reports server progress and the page from which the Extraction started. */
export function partialHeadline(partial: PartialResult): string {
  if (partial.strategy === 'ARTICLE') {
    return partial.document
      ? `Reading the document · ${partial.document.contextsAnswered} of ${partial.document.contexts} contexts`
      : 'Reading the document'
  }
  const from = partial.startedAtPage === null ? '' : ` · started at page ${partial.startedAtPage}`
  return `Reading records · ${partial.finished} of ${partial.discovered}${from}`
}
