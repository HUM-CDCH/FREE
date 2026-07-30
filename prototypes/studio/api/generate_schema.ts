import {
  generateSchemaWithModel,
  json,
  modelError,
  parseAnnotationMode,
  parseAnnotations,
  parseDocument,
  parseTemperature,
  type ExtractionStrategy,
} from './_model'

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData()
    const result = await generateSchemaWithModel({
      document: await parseDocument(form),
      annotations: parseAnnotations(form.get('annotations')),
      annotationsMode: parseAnnotationMode(form.get('annotations_mode')),
      strategy: parseStrategy(form.get('strategy')),
      temperature: parseTemperature(form.get('temperature')),
    })

    return json(result)
  } catch (error) {
    return modelError(error)
  }
}

// Optional: schema generation reads this only to word its guidance
// (_schema.ts's generalizationText); it defaults to 'article' phrasing when
// absent, same as extraction defaults to never sectioning when unset.
function parseStrategy(value: FormDataEntryValue | null): ExtractionStrategy | undefined {
  return value === 'catalog' || value === 'article' ? value : undefined
}
