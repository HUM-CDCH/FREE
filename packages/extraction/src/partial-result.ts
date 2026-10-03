import { z } from 'zod'
import { evidenceAnchorIdOf, evidenceSchema, plainEvidenceLink, unifiedEvidenceLink, unifiedEvidenceSchema } from './kei-artifact.js'
import type { EvidenceLink, ExtractionStrategy } from './types.js'

/** kei's progress document (`kie/extract/progress.py` `ProgressDocument`), pinned by
 *  `prototypes/parsing_service/tests/fixtures/contracts/extract.progress.json`. */
const count = z.number().int().nonnegative()
const relativePath = z.array(z.union([z.string(), z.number().int().nonnegative()]))
const progressLinkSchema = z.union([unifiedEvidenceSchema, evidenceSchema])
const contestSchema = z.object({ path: relativePath, candidates: z.array(z.unknown()) })
const progressEntrySchema = z.object({
  index: count,
  label: z.string().nullable(),
  page: z.number().int().positive().nullable(),
  stage: z.enum(['queued', 'reading', 'candidates', 'finished']),
  candidates: z.array(z.object({ path: relativePath, value: z.unknown(), quote: z.string().nullable(), window: count.optional() })).nullable(),
  record: z.record(z.string(), z.unknown()).nullable(),
  evidence: z.array(progressLinkSchema).nullable(),
  contested: z.array(contestSchema).nullable(),
  failed: count.nullable(),
})
export const progressDocumentSchema = z.object({
  version: z.literal(1),
  strategy: z.enum(['catalog', 'article']),
  started_at_page: z.number().int().positive().nullable(),
  discovered: count,
  finished: count,
  entries: z.array(progressEntrySchema),
  document: z.object({
    contexts: z.array(z.unknown()), answered: count, of: count, failed_contexts: count,
    links: z.array(progressLinkSchema), grounding_batches: count,
  }).nullable(),
})
export type ProgressDocument = z.infer<typeof progressDocumentSchema>

/** A value of a record still being read (design §1): grounded once its link exists, checking while it is a candidate,
 *  reading while the call that would answer it is in flight or failed, empty when the call that could have answered it
 *  succeeded without it, contested when verified values disagreed and arbitration chose none. */
export type PartialValueState = 'grounded' | 'checking' | 'reading' | 'empty' | 'contested'
/** queued: discovered, not yet read; reading: its values call is in flight; checking: its candidates are being verified
 *  (kei's `candidates` stage); finished: kei published the entry. */
export type PartialRecordState = 'queued' | 'reading' | 'checking' | 'finished'
export type PartialValue = Readonly<{ value: unknown; state: PartialValueState; candidates?: readonly unknown[] }>
export type PartialRecord = Readonly<{
  index: number
  label: string | null
  page: number | null
  state: PartialRecordState
  /** The values so far in the artifact's shape; null before the values call returned. */
  record: Readonly<Record<string, unknown>> | null
  /** Each leaf of `record` by its record-relative path (every step a string, JSON-encoded, as `ResultValue` paths are). */
  values: Readonly<Record<string, PartialValue>>
  evidenceLinks: readonly EvidenceLink[]
}>
/** A running Extraction's partial view (design §5): a view of files kei already wrote, never the record of truth. */
export type PartialResult = Readonly<{
  strategy: ExtractionStrategy
  startedAtPage: number | null
  discovered: number
  finished: number
  /** In the order they were read: nearest the start page first, then source order (kei's `work_order`). */
  records: readonly PartialRecord[]
  document: Readonly<{ contextsAnswered: number; contexts: number; groundingBatches: number }> | null
}>

/** Every leaf of a record with its record-relative path, nulls included: a null leaf is a field with nothing in it. */
function leavesOf(value: unknown, path: string[] = []): Array<{ path: string[]; value: unknown }> {
  if (Array.isArray(value)) return value.flatMap((item, index) => leavesOf(item, [...path, String(index)]))
  if (value !== null && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => leavesOf(item, [...path, key]))
  return [{ path, value }]
}
const populated = (value: unknown): boolean => value !== null && value !== undefined && value !== ''

function progressEvidenceLink(link: z.infer<typeof progressLinkSchema>): EvidenceLink {
  const anchorId = evidenceAnchorIdOf(link)
  return 'support' in link ? unifiedEvidenceLink(link, anchorId) : plainEvidenceLink(link, anchorId)
}

/** kei's `work_order` and Article's `context_order`: distance from the start page, an unknown page last, ties in source order. */
export function orderedByDistance<T extends { index: number; page: number | null }>(records: readonly T[], startPage: number | null): T[] {
  const distance = (record: T) => startPage === null ? 0 : record.page === null ? Number.POSITIVE_INFINITY : Math.abs(record.page - startPage)
  return [...records].sort((left, right) => distance(left) - distance(right) || left.index - right.index)
}

/**
 * kei's progress document as the partial view Studio shows, converted with the artifact reader's own link code; null
 * for a document outside the contract (a kei newer or older than this Studio), never a throw: the view is best effort.
 *
 * Per value: a leaf with a link is `grounded`; a populated leaf without one is `checking` (a candidate under
 * verification, or a finished value kei kept without a link); a null leaf is `contested` when the entry reports its
 * path as an unresolved contest, `reading` while a call that could still answer it is in flight or failed (an Article
 * context unanswered or failed, a Catalog values window failed), and `empty` otherwise (Ruling 7).
 */
export function partialFromProgress(raw: unknown): PartialResult | null {
  const parsed = progressDocumentSchema.safeParse(raw)
  if (!parsed.success) return null
  const progress = parsed.data
  const unanswered = progress.strategy === 'article' && progress.document !== null && progress.document.answered < progress.document.of
  const records = progress.entries.map((entry): PartialRecord => {
    const evidenceLinks = (entry.evidence ?? []).map(progressEvidenceLink)
    const linked = new Set(evidenceLinks.map((link) => JSON.stringify(link.resultPath.slice(2).map(String))))
    const contested = new Map((entry.contested ?? []).map((contest) => [JSON.stringify(contest.path.map(String)), contest.candidates]))
    const unknown = unanswered || (entry.failed ?? 0) > 0
    const values: Record<string, PartialValue> = {}
    if (entry.record !== null)
      for (const leaf of leavesOf(entry.record)) {
        const key = JSON.stringify(leaf.path)
        const candidates = contested.get(key)
        values[key] = linked.has(key) ? { value: leaf.value, state: 'grounded' }
          : populated(leaf.value) ? { value: leaf.value, state: 'checking' }
          : candidates ? { value: leaf.value, state: 'contested', candidates }
          : { value: leaf.value, state: unknown ? 'reading' : 'empty' }
      }
    return {
      index: entry.index, label: entry.label, page: entry.page,
      state: entry.stage === 'candidates' ? 'checking' : entry.stage,
      record: entry.record, values, evidenceLinks,
    }
  })
  return {
    strategy: progress.strategy === 'article' ? 'ARTICLE' : 'CATALOG',
    startedAtPage: progress.started_at_page,
    discovered: progress.discovered,
    finished: progress.finished,
    records: orderedByDistance(records, progress.started_at_page),
    document: progress.document === null
      ? null
      : { contextsAnswered: progress.document.answered, contexts: progress.document.of, groundingBatches: progress.document.grounding_batches },
  }
}
