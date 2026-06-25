import type { JSONSchema7 } from 'ai'
import type { Annotation, AnnotationMode } from './_document'

type JsonObjectSchema = {
  readonly type: 'object'
  readonly properties: Record<string, JSONSchema7>
  readonly required?: string[]
  readonly additionalProperties?: boolean
}

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

export function extractionPrompt(template: unknown, instruction: string | undefined): string {
  const extra = instruction?.trim()
  return `Extract structured information from this source document using this JSON extraction schema:

${JSON.stringify(template ?? {}, null, 2)}

Return exactly one JSON object matching the schema. Use null when a field is not present. Preserve arrays for repeating values.${extra ? `\n\nAdditional instruction:\n${extra}` : ''}`
}

export function schemaFromTemplate(template: unknown): JsonObjectSchema {
  if (!isRecord(template)) {
    return { type: 'object', properties: {}, additionalProperties: true }
  }

  const properties = Object.fromEntries(
    Object.entries(template).map(([key, value]) => [key, schemaForValue(value)]),
  )
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
}

function schemaForValue(value: unknown): JSONSchema7 {
  if (Array.isArray(value)) {
    return nullable({
      type: 'array',
      items: schemaForValue(value[0] ?? 'string'),
    })
  }

  if (isRecord(value)) {
    return nullable(schemaFromTemplate(value))
  }

  return nullable(primitiveSchema(String(value)))
}

function primitiveSchema(label: string): JSONSchema7 {
  switch (label) {
    case 'number':
      return { type: 'number' }
    case 'integer':
      return { type: 'integer' }
    case 'boolean':
      return { type: 'boolean' }
    case 'object':
      return { type: 'object', additionalProperties: true }
    case 'array':
      return { type: 'array', items: {} }
    default:
      return { type: 'string' }
  }
}

function nullable(schema: JSONSchema7): JSONSchema7 {
  return { anyOf: [schema, { type: 'null' }] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
