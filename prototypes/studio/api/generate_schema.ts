import { apiErrorResponse, assertFormFields, parseFormRequest } from './_http.js'
import {
  generateSchemaWithModel,
  json,
  parseDocument,
  parseInstruction,
  parseTemperature,
} from './_model.js'

const FIELDS = ['file', 'document_markdown', 'instruction', 'temperature'] as const

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await parseFormRequest(request)
    assertFormFields(form, FIELDS)
    const result = await generateSchemaWithModel({
      document: await parseDocument(form),
      instruction: parseInstruction(form.get('instruction')),
      temperature: parseTemperature(form.get('temperature')),
    })
    return json(result)
  } catch (error) {
    return apiErrorResponse(error)
  }
}
