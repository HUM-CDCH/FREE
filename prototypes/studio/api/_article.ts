import { type ExtractionSchemaEnvelope, type StructuredGenerator } from './_catalog.js'
import { conformToSchema } from './_model_output.js'

export async function extractArticle({
  document,
  schema,
  generate,
}: {
  readonly document: string
  readonly schema: ExtractionSchemaEnvelope
  readonly generate: StructuredGenerator
}): Promise<{
  readonly result: Record<string, unknown>
  readonly warnings: readonly string[]
}> {
  const generated = await generate({
    document,
    schema: schema.record,
    instructions: [
      'Extract one whole-document Article record matching the supplied record schema.',
      `Metadata: ${JSON.stringify(schema._schema_metadata)}`,
      'Use only the canonical document. Preserve schema-local _evidence and fully enumerate declared arrays.',
    ].join('\n\n'),
  })
  const conformed = conformToSchema(generated, schema.record)
  return {
    result: isRecord(conformed) ? conformed : {},
    warnings: [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
