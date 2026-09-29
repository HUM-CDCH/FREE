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
// When a field can only take one of a small closed set of values, give that field a literal array of the allowed values instead of a type label, for example "status": ["open", "closed", "unknown"].
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

When a field can only take one of a small closed set of values, give that field a literal array of the allowed values instead of a type label, for example "status": ["open", "closed", "unknown"].`
}

/** Schema design needs examples; extraction still receives the complete source. */
export function schemaSourceExcerpts(markdown: string): string {
  if (markdown.length <= 48_000) return markdown
  const pages = markdown.split(/(?=<!-- FREE:PAGE \d+ -->)/).filter(Boolean)
  const half = Math.max(1, Math.floor(46_000 / pages.length / 2))
  return 'Source excerpts from every physical page for schema design:\n' + pages.map((page) =>
    page.length <= half * 2 ? page : `${page.slice(0, half)}\n[... omitted for schema design ...]\n${page.slice(-half)}`,
  ).join('\n\n')
}
