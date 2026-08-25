import type {
  ParsedEvidenceAnchor,
  ParsedDocument,
  ProducerObservation,
  TextProducerObservation,
} from 'extraction/parsed-document'

export type EvidenceOccurrence = TextProducerObservation | ProducerObservation

export function anchorOccurrences(anchor: ParsedEvidenceAnchor): EvidenceOccurrence[] {
  return anchor.producer_observations
}

export function reviewedAnchorOccurrences(
  anchor: ParsedEvidenceAnchor,
  reviewedOccurrenceIds?: readonly string[],
): EvidenceOccurrence[] {
  return anchorOccurrences(anchor).filter(
    (occurrence) => !reviewedOccurrenceIds || reviewedOccurrenceIds.includes(occurrence.occurrence_id),
  )
}

export function verifiedEvidenceBbox(
  document: ParsedDocument,
  occurrence: EvidenceOccurrence,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const page = document.pages.find(
    (candidate) => candidate.page_number === occurrence.page_number,
  )
  if (!page) return null
  const raw = occurrence.bbox
  if (typeof raw.x0 !== 'number' || typeof raw.y0 !== 'number' || typeof raw.x1 !== 'number' || typeof raw.y1 !== 'number') return null
  if (![raw.x0, raw.y0, raw.x1, raw.y1].every(Number.isFinite) || raw.x1 <= raw.x0 || raw.y1 <= raw.y0) return null
  if (raw.x0 < 0 || raw.y0 < 0 || raw.x1 > page.width_pt || raw.y1 > page.height_pt) return null
  return { x0: raw.x0, y0: raw.y0, x1: raw.x1, y1: raw.y1 }
}
