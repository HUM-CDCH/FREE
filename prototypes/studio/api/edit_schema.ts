import {
  ApiError,
  apiErrorResponse,
  assertFormFields,
  parseFormRequest,
} from './_http.js'
import { editSchemaWithModel, json, parseTemperature } from './_model.js'

const FIELDS = ['current_template', 'instruction', 'document_markdown', 'temperature'] as const

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await parseFormRequest(request)
    assertFormFields(form, FIELDS)
    const currentTemplateRaw = form.get('current_template')
    const instruction = form.get('instruction')
    const markdown = form.get('document_markdown')
    if (typeof currentTemplateRaw !== 'string' || !currentTemplateRaw.trim()) {
      throw new ApiError(400, 'invalid_request', 'current_template is required')
    }
    if (typeof instruction !== 'string' || !instruction.trim()) {
      throw new ApiError(400, 'invalid_request', 'instruction is required')
    }
    if (markdown !== null && typeof markdown !== 'string') {
      throw new ApiError(400, 'invalid_request', 'document_markdown must be text or omitted')
    }

    let currentTemplate: unknown
    try {
      currentTemplate = JSON.parse(currentTemplateRaw)
    } catch (cause) {
      throw new ApiError(400, 'invalid_request', 'current_template is not valid JSON', { cause })
    }
    const ops = await editSchemaWithModel(
      currentTemplate,
      instruction.trim(),
      markdown,
      parseTemperature(form.get('temperature')),
    )
    return json({ ops })
  } catch (error) {
    return apiErrorResponse(error)
  }
}
