import type { EvidenceLink } from '../shared/groundedExtraction'
import type { GroundingIssue } from './extractionGrounding'

export type ExtractionState =
  | { status: 'idle' }
  | { status: 'running'; step: 'extraction' }
  | { status: 'running'; step: 'grounding'; result: Record<string, unknown> }
  | {
      status: 'ready'
      result: Record<string, unknown>
      evidenceLinks: readonly EvidenceLink[]
      groundingIssues: readonly GroundingIssue[]
      groundingError?: string
    }
  | { status: 'error'; message: string }
