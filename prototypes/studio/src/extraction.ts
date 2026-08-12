import type { EvidenceLink } from '../shared/groundedExtraction'

export type ExtractionState =
  | { status: 'idle' }
  | { status: 'running'; step: 'extraction' }
  | {
      status: 'ready'
      result: Record<string, unknown>
      evidenceLinks: readonly EvidenceLink[]
      ungroundedCount: number
    }
  | { status: 'error'; message: string }
  | { status: 'cancelled' }
