import type { Annotation, AnnotationMode } from './_document'

export function schemaPrompt(annotations: readonly Annotation[], mode: AnnotationMode): string {
  const annotationText =
    annotations.length === 0
      ? 'No annotations were supplied.'
      : annotations.map((item) => `- page ${item.pageNumber}: ${item.text}`).join('\n')

  const modeText =
    mode === 'fields'
      ? 'Use the annotations as the primary signal for fields, then check the whole document for structure.'
      : 'Use annotations as guidance, but infer the compact schema from the whole document.'

  const generalizationText =
    annotations.length === 0
      ? ''
      : ' The annotations are a representative excerpt the researcher highlighted, not an exhaustive list of every value to extract. If the document repeats a structural unit (for example, multiple similar records, entries, or sections), design the schema so it generalizes to every occurrence of that unit across the whole document, not only the annotated excerpt.'

  return `${modeText}${generalizationText}

Generate a compact JSON extraction schema for this source document. Return an object named "template". Field values should be simple type labels such as "verbatim-string", "string", "date", "number", "integer", "boolean", nested objects, or arrays.

Annotations:
${annotationText}`
}
