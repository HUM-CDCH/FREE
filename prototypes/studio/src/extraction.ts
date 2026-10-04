import type { ExtractionAttempt, PartialResult } from '../shared/extraction.contract'
import type { EvidenceLink } from '../shared/groundedExtraction'

export type ExtractionState =
  | { status: 'idle' }
  | { status: 'retained'; executionStatus: ExtractionAttempt['executionStatus'] }
  | { status: 'running'; step: 'extraction'; partial: PartialResult | null }
  | {
      status: 'ready'
      result: Record<string, unknown>
      evidenceLinks: readonly EvidenceLink[]
      ungroundedCount: number
    }
  | { status: 'error'; message: string }
  | { status: 'cancelled' }
