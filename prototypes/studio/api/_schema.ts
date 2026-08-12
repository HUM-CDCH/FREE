import type { Annotation, AnnotationMode } from './_document'
import type { ExtractionStrategy } from './_catalog_sections'

export function schemaPrompt(
  annotations: readonly Annotation[],
  mode: AnnotationMode,
  strategy: ExtractionStrategy = 'article',
): string {
  const effectiveMode = annotations.length === 0 ? 'hints' : mode
  const annotationText =
    annotations.length === 0
      ? 'No annotations were supplied.'
      : annotations.map((item) => `- page ${item.pageNumber}: ${item.text}`).join('\n')

  const modeText =
    effectiveMode === 'fields'
      ? 'The annotations below are the only content you are given — the rest of the Source Document has been withheld. Only include fields that are grounded in these annotations; do not invent additional fields.'
      : 'Use annotations as guidance, but infer the compact schema from the whole document.'

  // Catalog documents are extracted one repeating section at a time, with the
  // per-section results merged into a list automatically (see
  // _catalog_sections.ts) — so the schema itself must describe ONE occurrence
  // directly, not wrap itself in an array to represent the repetition; doing
  // both would double the repetition (once per section, again inside the
  // schema). Article documents get no such external repetition, so a genuine
  // repeating sub-list within the document must still be modeled as an array
  // field here — the pre-existing guidance below.
  const generalizationText =
    strategy === 'catalog'
      ? ' This document is a Catalog: it contains many structurally similar sections (for example, one section per grave, entry, or record). Extraction already runs once per section and merges the results into a list for you, so design this schema as the shape of ONE such section directly at the top level. Do not wrap the schema in an array to represent the repeated sections yourself — that repetition is handled outside the schema.'
      : annotations.length === 0
        ? ''
        : effectiveMode === 'fields'
          ? ' The annotations are a representative excerpt, not an exhaustive list of every value to extract. If an annotation looks like one instance of a repeating record (for example, one grave, entry, or section among several), design that field as an array so it can generalize to every occurrence — even though you cannot see the other occurrences here.'
          : ' The annotations are a representative excerpt the researcher highlighted, not an exhaustive list of every value to extract. If the document repeats a structural unit (for example, multiple similar records, entries, or sections), design the schema so it generalizes to every occurrence of that unit across the whole document, not only the annotated excerpt.'

  const articleStructureText =
    strategy === 'article' && annotations.length === 0
      ? ' If the source document is a scientific article, design the schema around article structure by default: include title, authors, abstract, keywords, and a sections array whose items capture each numbered or named section heading, its heading level, and a concise section summary. You may add compact article-specific fields for central research question, methods, key findings, and conclusion when they are clearly grounded in the document. Do not ignore visible article metadata or the heading hierarchy unless the annotations or researcher instructions indicate a different extraction goal.'
      : ''

  return `${modeText}${generalizationText}${articleStructureText}

Generate a compact JSON extraction schema for this source document. Return an object named "template". Field values should be simple type labels such as "verbatim-string", "string", "date", "number", "integer", "boolean", nested objects, or arrays.

Annotations:
${annotationText}`
}
