import { ApiError, apiErrorResponse, assertFormFields, parseFormRequest } from './_http.js'
import { json, parseTemperature } from './_model.js'
import { parseSchemaNodes, proposeSchemaEdit } from './_schema_edit.js'

const FIELDS = ['current_nodes', 'instruction', 'document_markdown', 'temperature'] as const

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await parseFormRequest(request)
    assertFormFields(form, FIELDS)
    const currentNodesRaw = form.get('current_nodes')
    const instruction = form.get('instruction')
    const markdown = form.get('document_markdown')
    if (typeof currentNodesRaw !== 'string' || !currentNodesRaw.trim()) {
      throw new ApiError(400, 'invalid_request', 'current_nodes is required')
    }
    if (typeof instruction !== 'string' || !instruction.trim()) {
      throw new ApiError(400, 'invalid_request', 'instruction is required')
    }
    if (markdown !== null && typeof markdown !== 'string') {
      throw new ApiError(400, 'invalid_request', 'document_markdown must be text or omitted')
    }

    let rawNodes: unknown
    try {
      rawNodes = JSON.parse(currentNodesRaw)
    } catch (cause) {
      throw new ApiError(400, 'invalid_request', 'current_nodes is not valid JSON', { cause })
    }
    let nodes
    try {
      nodes = parseSchemaNodes(rawNodes)
    } catch (cause) {
      throw new ApiError(400, 'invalid_request', 'current_nodes is invalid', { cause })
    }
    return json(await proposeSchemaEdit(nodes, instruction.trim(), markdown, {
      temperature: parseTemperature(form.get('temperature')),
    }))
  } catch (error) {
    return apiErrorResponse(error)
  }
}
