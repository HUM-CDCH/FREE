import type { SourcePageSpan } from 'db'
import type { SourceCoverage, SourceOmission } from '../shared/schemaSuggestionSource.contract.js'

// Superseded by a free-text chat instruction (see schemaPrompt below) — schema
// generation no longer takes highlighted-passage annotations as input. Left in
// place, commented out, rather than deleted.
//
// import type { Annotation, AnnotationMode } from './_document'
//
// export function schemaPrompt(annotations: readonly Annotation[], mode: AnnotationMode): string {
//   const annotationText =
//     annotations.length === 0
//       ? 'No annotations were supplied.'
//       : annotations.map((item) => `- page ${item.pageNumber}: ${item.text}`).join('\n')
//
//   const modeText =
//     mode === 'fields'
//       ? 'Use the annotations as the primary signal for fields, then check the whole document for structure.'
//       : 'Use annotations as guidance, but infer the compact schema from the whole document.'
//
//   return `${modeText}
//
// Generate a compact JSON extraction schema for this source document. Return an object named "template". Its first member must be "_description": one concise, explicit sentence defining what constitutes ONE root record in the source document. This record description must distinguish record boundaries (for example, one entry beginning at a numbered heading or one top-level numbered article section); field names alone are not a record definition. Field values should be simple type labels such as "verbatim-string", "string", "date", "number", "integer", "boolean", nested objects, or arrays.
//
// When a field can only take one of a small closed set of values, give that field a literal array of the allowed values instead of a type label, for example "status": ["open", "closed", "unknown"]. Write each allowed value exactly as the source writes it, in the source's language.
//
// Annotations:
// ${annotationText}`
// }

export function schemaPrompt(instruction: string): string {
  const instructionText =
    instruction.trim().length === 0
      ? ''
      : `Additional instruction from the researcher:\n${instruction.trim()}\n\n`

  return `${instructionText}Generate a compact JSON extraction schema for this source document. Return an object named "template". 
  
  Its first member must be "_description": one concise, explicit sentence defining what constitutes ONE root record in the source document. This record description must distinguish record boundaries (for example, one entry beginning at a numbered heading or one top-level numbered article section); field names alone are not a record definition. Field values should be simple type labels such as "verbatim-string", "string", "date", "number", "integer", "boolean", nested objects, or arrays.

Represent repeating values as a JSON array containing their item type, for example "references": ["verbatim-string"], and repeating objects as [{"name":"string"}]. Do not use the bare type labels "array" or "object"; specify their contents.

Place the actual requested field names directly inside "template", for example {"template":{"_description":"One numbered entry, including its listed items.","entry_number":"verbatim-string","items":["verbatim-string"]}}. Never return a "fields" list of name/type/description descriptors. Use the researcher's requested fields and record scope when supplied.

When a field can only take one of a small closed set of values, give that field a literal array of the allowed values instead of a type label, for example "status": ["open", "closed", "unknown"]. Write each allowed value exactly as the source writes it, in the source's language.`
}

/** The longest schema-suggestion input sent whole; past it, a source is excerpted. */
export const EXCERPT_THRESHOLD = 48_000
const EXCERPT_BUDGET = 46_000

/** The UTF-16 index of each ascending UTF-8 byte offset into `text`. An offset inside a character or past the end means
 *  the spans do not describe this Markdown, and a coverage declaration built on them would be false. */
function utf16Indices(text: string, offsets: readonly number[]): number[] {
  let bytes = 0
  let index = 0
  return offsets.map((offset) => {
    while (bytes < offset && index < text.length) {
      const code = text.codePointAt(index)!
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
      index += code < 0x10000 ? 1 : 2
    }
    if (bytes !== offset) throw new Error(`Page span offset ${offset} is not a character boundary of the source Markdown.`)
    return index
  })
}

const isLowSurrogate = (text: string, index: number) => (text.charCodeAt(index) & 0xfc00) === 0xdc00

/**
 * The whole source as consecutive windows of at most `EXCERPT_THRESHOLD` characters whose concatenation is the source:
 * each cut falls after the last paragraph break that fits, else at the limit (never inside a surrogate pair).
 */
export function schemaSourceWindows(markdown: string): string[] {
  const windows: string[] = []
  let start = 0
  while (markdown.length - start > EXCERPT_THRESHOLD) {
    let end = start + markdown.slice(start, start + EXCERPT_THRESHOLD).lastIndexOf('\n\n') + 2
    if (end <= start + 2) {
      end = start + EXCERPT_THRESHOLD
      if (/[\udc00-\udfff]/.test(markdown[end]!)) end -= 1
    }
    windows.push(markdown.slice(start, end))
    start = end
  }
  windows.push(markdown.slice(start))
  return windows
}

/**
 * Schema design needs examples; extraction still receives the complete source. A source over the threshold is sent
 * as each physical page's head and tail, and the result declares every range it did not send. Pages are the canonical
 * `pageSpans` (UTF-8 byte offsets); without them the source is one unnumbered range.
 */
export function schemaSourceExcerpts(
  markdown: string,
  pageSpans: readonly SourcePageSpan[] = [],
): { text: string; sourceCoverage: SourceCoverage } {
  if (markdown.length <= EXCERPT_THRESHOLD) return { text: markdown, sourceCoverage: { complete: true } }
  // The pages tile the source: each runs to the next one's start, the first from 0 and the last to the end.
  const starts = utf16Indices(markdown, pageSpans.map((span) => span.start))
  const pages = (pageSpans.length === 0
    ? [{ page: null, start: 0, end: markdown.length }]
    : pageSpans.map((span, i) => ({ page: span.pageNumber, start: i === 0 ? 0 : starts[i]!, end: starts[i + 1] ?? markdown.length }))
  ).filter((page) => page.end > page.start)
  const half = Math.max(1, Math.floor(EXCERPT_BUDGET / pages.length / 2))
  const omitted: SourceOmission[] = []
  const excerpts = pages.map(({ page, start, end }) => {
    const text = markdown.slice(start, end)
    if (text.length <= half * 2) return text
    // A cut that would split a surrogate pair gives the character up: the pair is omitted whole, never half sent.
    const headEnd = start + half - (isLowSurrogate(markdown, start + half) ? 1 : 0)
    const tailStart = end - half + (isLowSurrogate(markdown, end - half) ? 1 : 0)
    omitted.push({ page, start: headEnd, end: tailStart })
    return `${markdown.slice(start, headEnd)}\n[... omitted for schema design ...]\n${markdown.slice(tailStart, end)}`
  })
  return {
    text: (pageSpans.length === 0 ? 'Source excerpts for schema design:\n' : 'Source excerpts from every physical page for schema design:\n')
      + excerpts.join('\n\n'),
    sourceCoverage: omitted.length === 0
      ? { complete: true }
      : { complete: false, sourceCharacters: markdown.length, omitted },
  }
}
