/** Lexical containment shared by grounding and its reviewer-facing checks.
 *
 * Port of `normalize` and `bounded_contains` from
 * prototypes/grounding_lab/grounding_lab/pipeline.py; keep the two in step.
 * The lab's test cases are replayed in grounding.test.ts.
 */

// Word edges for any script; JS `\b` only knows ASCII.
const START = '(?<![\\p{L}\\p{N}_])'
const END = '(?![\\p{L}\\p{N}_])'

// 17.06.1790 / 17/06/1790 / 17-06-1790 -> 1790-06-17 (zero-padded)
const DMY_DATE = new RegExp(`${START}(\\d{1,2})[./-](\\d{1,2})[./-](\\d{4})${END}`, 'gu')
const ISO_DATE = new RegExp(`${START}(\\d{4})-(\\d{1,2})-(\\d{1,2})${END}`, 'gu')
// "13. august 2004" / "August 13, 2004" / "17 juin 1790" -> 2004-08-13
const DAY_MONTHNAME_YEAR = new RegExp(`${START}(\\d{1,2})\\.?\\s+(\\p{L}+)\\.?\\s+(\\d{4})${END}`, 'gu')
const MONTHNAME_DAY_YEAR = new RegExp(`${START}(\\p{L}+)\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})${END}`, 'gu')
const GROUPING_SEP = /(?<=\d)[.,](?=\d{3}(?!\d))/g
// Digit grouping by space. Documents: only typographic no-break spaces
// (U+00A0/U+202F) are joined, before NFKC folds them; a plain space between
// numbers in a table row ("page 5 200", "475 482") is two values, not one.
// A scalar claim value is one number, so there a plain space is grouping too.
const NBSP_GROUPING = /(?<=\d)[  ](?=\d{3}(?!\d))/g
const SPACE_GROUPING = /(?<!\d)(\d{1,3})((?: \d{3})+)(?!\d)/g
// "1300m2" -> "1300 m2": extractors emit "1300 m2", documents glue the unit.
const DIGIT_LETTER = /(?<=\d)(?=\p{L})/gu

const MONTHS = new Map<string, number>()
for (const [index, names] of [
  'january januar janvier gennaio enero jan',
  'february februar février fevrier febbraio febrero feb',
  'march marts märz maerz mars marzo mar',
  'april avril aprile abril apr',
  'may maj mai maggio mayo',
  'june juni juin giugno junio jun',
  'july juli juillet luglio julio jul',
  'august août aout agosto aug',
  'september septembre settembre septiembre sep sept',
  'october oktober octobre ottobre octubre oct okt',
  'november novembre noviembre nov',
  'december dezember décembre decembre dicembre diciembre dec dez',
].entries())
  for (const name of names.split(' ')) MONTHS.set(name, index + 1)

const pad = (n: number) => String(n).padStart(2, '0')

function namedDate(original: string, day: string, month: string, year: string): string {
  const number = MONTHS.get(month)
  const d = Number(day)
  return number === undefined || d < 1 || d > 31 ? original : `${year}-${pad(number)}-${pad(d)}`
}

function dmyToIso(original: string, day: string, month: string, year: string): string {
  const d = Number(day)
  const m = Number(month)
  // "35.06.1790" is section numbering, not a date
  return d < 1 || d > 31 || m < 1 || m > 12 ? original : `${year}-${pad(m)}-${pad(d)}`
}

const isCurrency = (ch: string) => /\p{Sc}/u.test(ch)

export function normalizeLexical(text: string): string {
  let out = text.replace(NBSP_GROUPING, '')
  // U+2212 minus and U+2013 en-dash both read as "-" so a range stays one token.
  out = out.normalize('NFKC').toLowerCase().replace(/[−–]/g, '-')
  out = out.replace(DAY_MONTHNAME_YEAR, (m, day, month, year) => namedDate(m, day, month, year))
  out = out.replace(MONTHNAME_DAY_YEAR, (m, month, day, year) => namedDate(m, day, month, year))
  out = out.replace(DMY_DATE, dmyToIso)
  out = out.replace(ISO_DATE, (_, y, m, d) => `${y}-${pad(Number(m))}-${pad(Number(d))}`)
  // ponytail: grouping-separator heuristic — "1.234,56" and "1,234.56" both
  // become "1234.56"; ambiguous 3-digit decimals ("1,234") read as grouping.
  out = out.replace(GROUPING_SEP, '').replace(/(?<=\d),(?=\d)/g, '.')
  // Keep semantic numeric markers. Dropping them makes "$50" and "50%"
  // indistinguishable and turns a wrong lexical link into a verbatim one.
  out = out.replace(/[^\p{L}\p{N}\s_.\-%\p{Sc}]/gu, ' ').replace(/\s+/g, ' ').replace(/\s+%/g, '%')
  // A currency symbol glues to the number on either side ("$ 50", "50 €")
  // unless it starts the next number: "in 2024 ($116,800)" must not become
  // "2024$116800".
  out = out.replace(/(\S)\s+(?=\d)/gu, (m, ch) => (isCurrency(ch) ? ch : m))
  out = out.replace(/(?<=\d)\s+(\S)(?!\d)/gu, (m, ch) => (isCurrency(ch) ? ch : m))
  return out.replace(DIGIT_LETTER, ' ').trim()
}

/** A claim value is one number, so every space group in it is grouping. */
function joinSpaceGroups(scalar: string): string {
  return scalar.replace(SPACE_GROUPING, (_, head, tail) => head + tail.replaceAll(' ', ''))
}

/** In a document, join a space group only when it is at least five digits or
 *  the whole cell is that number; "page 5 200" remains two adjacent values. */
function joinDocumentSpaceGroups(text: string): string {
  return text.replace(SPACE_GROUPING, (m, head, tail, offset: number) => {
    const digits = head + tail.replaceAll(' ', '')
    const outside = (text.slice(0, offset) + text.slice(offset + m.length)).trim()
    const isolatedCell = [...outside].every((ch) => ch === '-' || ch === '%' || isCurrency(ch))
    return digits.length >= 5 || isolatedCell ? digits : m
  })
}

/** An anchor's text prepared once per document for every claim's matcher. */
export type LexicalText = Readonly<{ normalized: string; joined: string }>

export function lexicalText(text: string): LexicalText {
  const normalized = normalizeLexical(text)
  return { normalized, joined: joinDocumentSpaceGroups(normalized) }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Match whole tokens, including numeric signs, decimals and ranges. */
export function tokenMatcher(value: string): (text: LexicalText) => boolean {
  const needle = normalizeLexical(value)
  if (!needle) return () => false
  // safe for one-character table cells
  if (needle.length === 1 && !/\d/.test(needle)) return (text) => text.normalized === needle
  const patterns = [...new Set([needle, joinSpaceGroups(needle)])].map((n) => {
    const numericStart = /^\d/.test(n) ? '(?<![.-])' : ''
    const numericEnd = /\d$/.test(n) ? '(?!\\.\\d)' : ''
    return new RegExp(`${START}(?<!\\d-)${numericStart}${escapeRegExp(n)}${END}(?!-\\d)${numericEnd}`, 'u')
  })
  return (text) =>
    patterns.some((pattern) => pattern.test(text.normalized) || (text.joined !== text.normalized && pattern.test(text.joined)))
}

export function boundedContains(value: string | number | boolean, text: string): boolean {
  return tokenMatcher(String(value))(lexicalText(text))
}

/** The one candidate anchor containing the value as a bounded token, or
 *  null when none or several do. Booleans never match. */
export function lexicalUniqueHit(
  value: string | number | boolean,
  textByAnchorId: ReadonlyMap<string, LexicalText>,
): string | null {
  if (typeof value === 'boolean') return null
  const matches = tokenMatcher(String(value))
  let hit: string | null = null
  for (const [anchorId, text] of textByAnchorId) {
    if (!matches(text)) continue
    if (hit !== null) return null
    hit = anchorId
  }
  return hit
}

export type LexicalCheck = Readonly<{ verbatim: boolean; lexicalHits: number }>

/** The two doubts a reviewer can hold about one link: is the value in the
 *  linked anchor, and in how many candidate anchors does it occur at all.
 *  Booleans are never verbatim in a source and get no check. Neither number
 *  is a probability and neither authorizes auto-accept. */
export function lexicalCheck(
  value: string | number | boolean,
  anchorId: string,
  textByAnchorId: ReadonlyMap<string, LexicalText>,
): LexicalCheck | null {
  if (typeof value === 'boolean') return null
  const matches = tokenMatcher(String(value))
  let lexicalHits = 0
  for (const text of textByAnchorId.values()) if (matches(text)) lexicalHits += 1
  const linked = textByAnchorId.get(anchorId)
  return { verbatim: linked !== undefined && matches(linked), lexicalHits }
}
