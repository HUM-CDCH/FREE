import type { EvidenceLink } from '../shared/groundedExtraction'
import type { GroundingIssue } from '../shared/extractionGrounding'

export type ExtractionState =
  | { status: 'idle' }
  | { status: 'running'; step: 'extraction' }
  | {
      status: 'ready'
      result: Record<string, unknown>
      evidenceLinks: readonly EvidenceLink[]
      groundingIssues: readonly GroundingIssue[]
    }
  | { status: 'error'; message: string }
  | { status: 'cancelled' }
