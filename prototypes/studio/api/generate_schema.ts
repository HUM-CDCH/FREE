import { apiErrorResponse, assertFormFields, parseFormRequest, type FormValue } from './_http.js'
import {
  generateSchemaWithModel,
  json,
  parseAnnotationMode,
  parseAnnotations,
  parseDocument,
  parseTemperature,
  type ExtractionStrategy,
} from './_model.js'

const FIELDS = ['file', 'document_markdown', 'annotations', 'annotations_mode', 'temperature', 'strategy'] as const

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await parseFormRequest(request)
    assertFormFields(form, FIELDS)
    const result = await generateSchemaWithModel({
      document: await parseDocument(form),
      annotations: parseAnnotations(form.get('annotations')),
      annotationsMode: parseAnnotationMode(form.get('annotations_mode')),
      strategy: parseStrategy(form.get('strategy')),
      temperature: parseTemperature(form.get('temperature')),
    })
    return json(result)
  } catch (error) {
    return apiErrorResponse(error)
  }
}

// Optional: schema generation reads this only to word its guidance.
function parseStrategy(value: FormValue | null): ExtractionStrategy | undefined {
  return value === 'catalog' || value === 'article' ? value : undefined
}
