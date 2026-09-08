import { boundedContains } from '../../../../packages/extraction/src/lexical.js'
import type { Field } from './schema.js'

export type Candidate = { anchorId: string; text: string }
export function lexicalCandidates(field: Field, value: unknown, candidates: readonly Candidate[], fieldAware: boolean): Candidate[] {
  if (value == null || value === '') return []
  let selected = candidates
  if (fieldAware) {
    if (['catalog_number', 'locality', 'locality_part', 'findspot'].includes(field)) {
      selected = candidates.filter(e => /^\s*\d+\.\s+\p{L}/u.test(e.text) && /\bFdpl\./.test(e.text))
    } else if (field === 'map_sheet') {
      return candidates.filter(e => Number(/\bMbl\.\s*(\d{4})/.exec(e.text)?.[1]) === value)
    } else if (field === 'find_type') {
      // The first FA belongs to the parent; later FA or b) EF cannot supersede it.
      const candidate = candidates.find(e => /\bFA:\s*\w+/.test(e.text))
      const code = candidate && /\bFA:\s*(\w+)/.exec(candidate.text)?.[1]
      return candidate && code === String(value).replace(/\.$/, '') ? [candidate] : []
    }
  }
  return selected.filter(entry => {
    let text = entry.text.replace(/[—–−]/g, '-')
    if (field === 'burial_axis') text = text.replace(/0-W/g, 'O-W')
    return boundedContains(String(value), text)
  })
}
