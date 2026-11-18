import type { ValuePart } from './durableRailModel'
import { evidenceCheck } from './reviewVocabulary'

export type PartState = 'to-check' | 'approved' | 'unread' | 'unrecorded'
export const PART_STATE_WORD: Record<PartState, string> = {
  'to-check': 'To check', approved: 'Approved', unread: 'Not read', unrecorded: 'No individual approval recorded',
}

/** Why a populated part asks to be checked. */
export function partFlag(part: ValuePart): string | null {
  if (part.value === null || part.value === undefined || part.value === '') return null
  return part.link ? evidenceCheck(part.link) : 'Source not found'
}

export const partState = (part: ValuePart, wholeApproved = false): PartState => {
  if (part.approved) return 'approved'
  if (wholeApproved) return 'unrecorded'
  return partFlag(part) ? 'to-check' : 'unread'
}

export type PartsReview = {
  open: boolean
  wholeApproved?: boolean
  advance?: boolean
  onApproval: (part: ValuePart, approved: boolean) => void
}
