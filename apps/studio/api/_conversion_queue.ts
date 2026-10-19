import type { DBOSClient, WorkflowStatus } from '@dbos-inc/dbos-sdk'
import { KEI_QUEUE, keiConvertOkSchema, keiConvertWorkflowId } from 'extraction/kei-handoff'

const LANES = [KEI_QUEUE.convertSmall, KEI_QUEUE.convertLarge]
const CONVERT_PREFIX = keiConvertWorkflowId('')
/** How many of kei's latest conversions calibrate the cost per page, and how few still say nothing. */
const SAMPLE_SIZE = 50
const MIN_SAMPLES = 3
/** A calibration holds this long: conversions take minutes, and the listing is read every few seconds. */
export const CALIBRATION_TTL_MS = 5 * 60 * 1000
/** Bounds on a calibrated cost per page, so a run of reused results cannot promise an instant conversion. */
const MIN_MS_PER_PAGE = 500
const MAX_MS_PER_PAGE = 120_000

/** One conversion on a lane, as kei's DBOS lists it. `pages` is its Studio parent's admitted count, when known. */
export type LaneJob = { conversionId: string; createdAt: number; startedAt: number | null; pages: number | null }

/** What every project's live conversions and kei's recent history say about the lanes. */
export type ConversionQueue = Readonly<{
  /** Calibrated from kei's recent conversions; null keeps kei's measured default. */
  msPerPage: number | null
  /** The median size of those conversions per lane: the size assumed for a job of unknown size. */
  typicalPages: ReadonlyMap<string, number>
  /** Each lane's live conversions, in kei's order (one constant priority, so oldest first). */
  lanes: ReadonlyMap<string, readonly LaneJob[]>
}>

type Sample = { lane: string; pages: number; ms: number }

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** One completed conversion's pages and run time (dequeue to completion, so without its wait), or null. */
export function sampleOf(status: WorkflowStatus): Sample | null {
  const ended = status.completedAt ?? status.updatedAt
  const output = keiConvertOkSchema.safeParse(status.output)
  if (!output.success || status.dequeuedAt === undefined || ended === undefined || !status.queueName) return null
  const ms = ended - status.dequeuedAt
  return ms > 0 ? { lane: status.queueName, pages: output.data.page_count, ms } : null
}

/** The cost per page beyond kei's fixed overhead: the median, which a few reused or native results do not drag. */
export function calibrate(samples: readonly Sample[], overheadMs: number): number | null {
  if (samples.length < MIN_SAMPLES) return null
  const perPage = median(samples.map((sample) => Math.max(0, sample.ms - overheadMs) / sample.pages))
  return Math.min(MAX_MS_PER_PAGE, Math.max(MIN_MS_PER_PAGE, Math.round(perPage)))
}

type Calibration = Pick<ConversionQueue, 'msPerPage' | 'typicalPages'>

/**
 * Reads the lanes for the listing's estimates: the calibration at most every five minutes, the live conversions on
 * every read. Only counts and times leave this module: another researcher's conversion is never named.
 */
export function createConversionQueueReader(options: {
  kei: () => Pick<DBOSClient, 'listWorkflows'>
  admission: () => Pick<DBOSClient, 'listWorkflows'>
  overheadMs: number
  now?: () => number
}) {
  const now = options.now ?? Date.now
  let cached: { at: number; calibration: Calibration } | null = null

  async function calibration(): Promise<Calibration> {
    if (cached && now() - cached.at < CALIBRATION_TTL_MS) return cached.calibration
    const completed = await options.kei().listWorkflows({
      workflowName: 'convert', status: 'SUCCESS', queueName: LANES,
      sortDesc: true, limit: SAMPLE_SIZE, loadInput: false, loadOutput: true,
    })
    const samples = completed.flatMap((status) => sampleOf(status) ?? [])
    const typicalPages = new Map<string, number>()
    for (const lane of LANES) {
      const pages = samples.filter((sample) => sample.lane === lane).map((sample) => sample.pages)
      if (pages.length) typicalPages.set(lane, Math.round(median(pages)))
    }
    cached = { at: now(), calibration: { msPerPage: calibrate(samples, options.overheadMs), typicalPages } }
    return cached.calibration
  }

  return async function readConversionQueue(): Promise<ConversionQueue> {
    const live = await options.kei().listWorkflows({
      workflowName: 'convert', status: ['ENQUEUED', 'PENDING'], queueName: LANES, loadInput: false, loadOutput: false,
    })
    const parents = live.flatMap((status) =>
      status.workflowID.startsWith(CONVERT_PREFIX) ? [status.workflowID.slice(CONVERT_PREFIX.length)] : [])
    const recorded = parents.length
      ? await options.admission().listWorkflows({ workflowIDs: parents, loadInput: true, loadOutput: false })
      : []
    const pagesOf = new Map(recorded.map((status) => {
      const pages = (status.input?.[0] as { pageCount?: unknown } | undefined)?.pageCount
      return [status.workflowID, Number.isInteger(pages) && (pages as number) > 0 ? pages as number : null] as const
    }))
    const lanes = new Map<string, LaneJob[]>(LANES.map((lane) => [lane, []]))
    for (const status of [...live].sort((a, b) => a.createdAt - b.createdAt || a.workflowID.localeCompare(b.workflowID))) {
      const parent = status.workflowID.startsWith(CONVERT_PREFIX) ? status.workflowID.slice(CONVERT_PREFIX.length) : null
      lanes.get(status.queueName ?? '')?.push({
        conversionId: status.workflowID,
        createdAt: status.createdAt,
        startedAt: status.status === 'PENDING' ? status.dequeuedAt ?? null : null,
        pages: parent === null ? null : pagesOf.get(parent) ?? null,
      })
    }
    return { ...await calibration(), lanes }
  }
}
