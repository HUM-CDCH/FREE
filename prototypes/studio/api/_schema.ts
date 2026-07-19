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

  return `${modeText}

Generate a compact JSON extraction schema for this source document. Return an object named "template". Field values should be simple type labels such as "verbatim-string", "string", "date", "number", "integer", "boolean", nested objects, or arrays.

Annotations:
${annotationText}`
}
