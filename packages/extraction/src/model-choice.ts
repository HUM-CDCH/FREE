import type { ExtractionModelChoice } from './types.js'

const ROLES = ['fields', 'reasoning'] as const

/** An Extraction Model Choice in its one canonical form: only the roles given a non-empty kei-exp model key, and null
 *  when no role was chosen, so that an absent, null and empty choice are the same request. Reads a stored jsonb value
 *  as well as a caller's input. */
export function modelChoice(value: unknown): ExtractionModelChoice | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const chosen: { fields?: string; reasoning?: string } = {}
  for (const role of ROLES) {
    const key = (value as Record<string, unknown>)[role]
    if (typeof key === 'string' && key !== '') chosen[role] = key
  }
  return Object.keys(chosen).length === 0 ? null : chosen
}
