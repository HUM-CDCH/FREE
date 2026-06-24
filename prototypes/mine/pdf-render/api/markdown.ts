import { json, markdownWithModel, modelError, parseDocument, parseTemperature } from './_model'

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData()
    const result = await markdownWithModel({
      document: await parseDocument(form),
      temperature: parseTemperature(form.get('temperature')),
    })

    return json(result)
  } catch (error) {
    return modelError(error)
  }
}
