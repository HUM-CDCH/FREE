import {
  ApiError,
  apiErrorResponse,
  assertFormFields,
  parseFormRequest,
  type FormValue,
} from './_http.js'
import { extractWithModel, json, parseDocument, parseTemperature } from './_model.js'

const FIELDS = ['file', 'document_markdown', 'template', 'instruction', 'temperature'] as const

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await parseFormRequest(request)
    assertFormFields(form, FIELDS)
    const result = await extractWithModel({
      document: await parseDocument(form),
      template: parseTemplate(form.get('template')),
      instruction: optionalString(form.get('instruction'), 'instruction'),
      temperature: parseTemperature(form.get('temperature')),
    })
    return json({
      result: result.result,
      raw: result.raw,
      reasoning: result.reasoning,
      pages: result.pages,
      modelAttribution: result.modelAttribution,
    })
  } catch (error) {
    return apiErrorResponse(error)
  }
}

function parseTemplate(value: FormValue | null): unknown {
  if (value === null || value === '') return {}
  if (typeof value !== 'string') {
    throw new ApiError(400, 'invalid_request', 'template must be JSON')
  }
  try {
    return JSON.parse(value)
  } catch (cause) {
    throw new ApiError(400, 'invalid_request', 'template must be valid JSON', { cause })
  }
}

function optionalString(value: FormValue | null, name: string): string | undefined {
  if (value === null || (typeof value === 'string' && value.trim() === '')) return undefined
  if (typeof value !== 'string') throw new ApiError(400, 'invalid_request', `${name} must be text`)
  return value
}
