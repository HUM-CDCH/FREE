/** Lexical containment shared by grounding and its reviewer-facing checks.
 *
 * ponytail: reduced port of grounding_lab/pipeline.py `normalize` (NFKC,
 * casefold, dash and decimal-comma unification, punctuation to spaces). Port
 * its date, digit-grouping and currency rules when reviewers see too many
 * correct dates or large numbers flagged as not in the passage.
 */

const WORD = '[\\p{L}\\p{N}_]'

export function normalizeLexical(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[−–]/g, '-')
    .replace(/(?<=\d),(?=\d)/g, '.')
    .replace(/[^\p{L}\p{N}\s_.\-%\p{Sc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Matcher for a normalized needle as a bounded token: "4" is not in "1904",
 *  and a hyphen glues digits into one token so "4.4" is not in "4.3-4.4". */
export function tokenMatcher(needle: string): (haystack: string) => boolean {
  if (!needle) return () => false
  if (needle.length === 1 && !/\d/.test(needle)) return (haystack) => haystack === needle
  const pattern = new RegExp(`(?<!${WORD})(?<!\\d-)${escapeRegExp(needle)}(?!${WORD})(?!-\\d)`, 'u')
  return (haystack) => pattern.test(haystack)
}

export function boundedContains(needle: string, haystack: string): boolean {
  return tokenMatcher(needle)(haystack)
}

export type LexicalCheck = Readonly<{ verbatim: boolean; lexicalHits: number }>

/** The two doubts a reviewer can hold about one link: is the value in the
 *  linked anchor, and in how many candidate anchors does it occur at all.
 *  Booleans are never verbatim in a source and get no check. Neither number
 *  is a probability and neither authorizes auto-accept. */
export function lexicalCheck(
  value: string | number | boolean,
  anchorId: string,
  normalizedTextByAnchorId: ReadonlyMap<string, string>,
): LexicalCheck | null {
  if (typeof value === 'boolean') return null
  const matches = tokenMatcher(normalizeLexical(String(value)))
  let lexicalHits = 0
  for (const text of normalizedTextByAnchorId.values()) if (matches(text)) lexicalHits += 1
  return { verbatim: matches(normalizedTextByAnchorId.get(anchorId) ?? ''), lexicalHits }
}
