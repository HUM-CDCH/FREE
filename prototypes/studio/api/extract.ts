import {
  extractWithModel,
  json,
  modelError,
  parseDocument,
  parseTemperature,
  RequestError,
} from './_model'

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData()
    const template = parseTemplate(form.get('template'))
    const instruction = stringValue(form.get('instruction'))
    const result = await extractWithModel({
      document: await parseDocument(form),
      template,
      instruction,
      temperature: parseTemperature(form.get('temperature')),
    })

    return json(result)
  } catch (error) {
    return modelError(error)
  }
}

function parseTemplate(value: FormDataEntryValue | null): unknown {
  if (value === null || value === '') {
    return {}
  }
  if (typeof value !== 'string') {
    throw new RequestError(400, 'template must be JSON')
  }
  return JSON.parse(value)
}

function stringValue(value: FormDataEntryValue | null): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
