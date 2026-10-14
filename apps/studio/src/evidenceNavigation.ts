import type {
  ParsedEvidenceAnchor,
  ParsedDocument,
  ProducerObservation,
  TextProducerObservation,
} from 'extraction/parsed-document'
import type { EvidenceLink } from '../shared/groundedExtraction'

export type EvidenceOccurrence = TextProducerObservation | ProducerObservation

export function anchorOccurrences(anchor: ParsedEvidenceAnchor): EvidenceOccurrence[] {
  return anchor.producer_observations
}

/** A continued value keeps its primary precision and locates its other source segments by their canonical anchors. */
export function sourceEvidenceLinks(link: EvidenceLink, anchors: ReadonlySet<string>): EvidenceLink[] {
  const links = [link]
  if (link.precision === 'input') return links
  for (const { segment } of link.grounding?.textSpans ?? []) {
    const id = `a_${segment}`
    // A primary cell already locates this segment more precisely; keep it alone.
    if (link.evidenceAnchorId === id || link.evidenceAnchorId.startsWith(`${id}_`) || !anchors.has(id)
      || links.some(each => each.evidenceAnchorId === id)) continue
    links.push({ ...link, evidenceAnchorId: id, precision: 'segment' })
  }
  return links
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
