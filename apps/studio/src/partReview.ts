import type { ParsedDocument } from 'extraction/parsed-document'
import { reviewLinkDoubt, type ValuePart } from './durableRailModel'

export type PartState = 'to-check' | 'approved' | 'unread' | 'unrecorded'
export const PART_STATE_WORD: Record<PartState, string> = {
  'to-check': 'To check', approved: 'Approved', unread: 'Not read', unrecorded: 'No individual approval recorded',
}

/** Why a populated part asks to be checked. */
export function partFlag(part: ValuePart, document: ParsedDocument | null = null): string | null {
  if (part.value === null || part.value === undefined || part.value === '') return null
  return part.link ? reviewLinkDoubt(part.link, part.value, document) : 'Source not found'
}

export const partState = (part: ValuePart, wholeApproved = false, document: ParsedDocument | null = null): PartState => {
  if (part.approved) return 'approved'
  if (wholeApproved) return 'unrecorded'
  return partFlag(part, document) ? 'to-check' : 'unread'
}

export type PartsReview = {
  document?: ParsedDocument | null
  open: boolean
  wholeApproved?: boolean
  advance?: boolean
  onApproval: (part: ValuePart, approved: boolean) => void
}
