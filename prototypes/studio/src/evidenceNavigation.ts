import type {
  ParsedEvidenceAnchor,
  ParsedDocumentV2,
  ProducerObservation,
  TextEvidenceAnchor,
} from './parsedDocument'

export function normalizeEvidenceText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function findTextLayerMatch(page: ParentNode, text: string): HTMLElement | null {
  const needle = normalizeEvidenceText(text)
  if (!needle) return null
  const spans = [...page.querySelectorAll<HTMLElement>('.textLayer span')]
  let combined = ''
  for (const span of spans) {
    const part = normalizeEvidenceText(span.textContent ?? '')
    if (!part) continue
    combined = normalizeEvidenceText(`${combined} ${part}`)
    if (combined.includes(needle.slice(0, Math.min(80, needle.length)))) return span
  }
  return null
}

export type EvidenceOccurrence = Pick<
  TextEvidenceAnchor,
  'occurrence_id' | 'page_number' | 'bbox'
> | ProducerObservation

export function anchorOccurrences(anchor: ParsedEvidenceAnchor): EvidenceOccurrence[] {
  return anchor.kind === 'text'
    ? [anchor]
    : anchor.producer_observations
}

export function verifiedEvidenceBbox(
  document: ParsedDocumentV2,
  occurrence: EvidenceOccurrence,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const page = document.pages.find(
    (candidate) => candidate.page_number === occurrence.page_number,
  )
  const rotation = ((page?.rotation ?? 0) % 360 + 360) % 360
  if (
    rotation !== 0 ||
    !page ||
    !page.width_pt ||
    !page.height_pt
  ) return null
  const raw = occurrence.bbox
  if (!raw || typeof raw.x0 !== 'number' || typeof raw.y0 !== 'number' || typeof raw.x1 !== 'number' || typeof raw.y1 !== 'number') return null
  if (![raw.x0, raw.y0, raw.x1, raw.y1].every(Number.isFinite) || raw.x1 <= raw.x0 || raw.y1 <= raw.y0) return null
  if (raw.x0 < 0 || raw.y0 < 0 || raw.x1 > page.width_pt || raw.y1 > page.height_pt) return null
  return { x0: raw.x0, y0: raw.y0, x1: raw.x1, y1: raw.y1 }
}

export function blockText(document: ParsedDocumentV2, anchor: TextEvidenceAnchor): string {
  const block = document.content_stream.find((candidate) => candidate.block_id === anchor.block_id)
  if (!block) return ''
  return 'text' in block ? block.text : block.kind === 'list' ? block.items.join(' ') : ''
}
