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
const PAGE_MARKER = /^<!-- FREE:PAGE (\d+) -->/

/**
 * Schema design needs examples; extraction still receives the complete source. A source over the threshold is sent
 * as each physical page's head and tail, and the result declares every range it did not send.
 */
export function schemaSourceExcerpts(markdown: string): { text: string; sourceCoverage: SourceCoverage } {
  if (markdown.length <= EXCERPT_THRESHOLD) return { text: markdown, sourceCoverage: { complete: true } }
  const pages = markdown.split(/(?=<!-- FREE:PAGE \d+ -->)/).filter(Boolean)
  const half = Math.max(1, Math.floor(EXCERPT_BUDGET / pages.length / 2))
  const omitted: SourceOmission[] = []
  let offset = 0
  const excerpts = pages.map((page) => {
    const start = offset
    offset += page.length
    if (page.length <= half * 2) return page
    const marker = PAGE_MARKER.exec(page)
    omitted.push({ page: marker ? Number(marker[1]) : null, start: start + half, end: start + page.length - half })
    return `${page.slice(0, half)}\n[... omitted for schema design ...]\n${page.slice(-half)}`
  })
  return {
    text: 'Source excerpts from every physical page for schema design:\n' + excerpts.join('\n\n'),
    sourceCoverage: omitted.length === 0
      ? { complete: true }
      : { complete: false, sourceCharacters: markdown.length, omitted },
  }
}
