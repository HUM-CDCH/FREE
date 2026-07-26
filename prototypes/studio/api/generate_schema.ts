import { apiErrorResponse, assertFormFields, parseFormRequest } from './_http.js'
import {
  generateSchemaWithModel,
  json,
  parseAnnotationMode,
  parseAnnotations,
  parseDocument,
  parseTemperature,
} from './_model.js'

const FIELDS = ['file', 'document_markdown', 'annotations', 'annotations_mode', 'temperature'] as const

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await parseFormRequest(request)
    assertFormFields(form, FIELDS)
    const result = await generateSchemaWithModel({
      document: await parseDocument(form),
      annotations: parseAnnotations(form.get('annotations')),
      annotationsMode: parseAnnotationMode(form.get('annotations_mode')),
      temperature: parseTemperature(form.get('temperature')),
    })
    return json(result)
  } catch (error) {
    return apiErrorResponse(error)
  }
}
