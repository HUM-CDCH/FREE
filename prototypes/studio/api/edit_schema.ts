import { editSchemaWithModel, json, modelError } from './_model'
import { parseUnknownJson } from './_model_output'

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData()
    const currentTemplateRaw = form.get('current_template')
    const instruction = form.get('instruction')

    if (typeof currentTemplateRaw !== 'string' || !currentTemplateRaw.trim()) {
      return json({ error: 'current_template is required' }, { status: 400 })
    }
    if (typeof instruction !== 'string' || !instruction.trim()) {
      return json({ error: 'instruction is required' }, { status: 400 })
    }

    const currentTemplate = await parseUnknownJson(currentTemplateRaw, 'current_template is not valid JSON.')
    const ops = await editSchemaWithModel(currentTemplate, instruction.trim())
    return json({ ops })
  } catch (error) {
    return modelError(error)
  }
}
