import {
  canonicalPackageStore,
  type CanonicalPackageStore,
} from '../../../packages/db/src/artifact-store.js'
import type { ResearcherProjectStore } from '../../../packages/db/src/project-store.js'
import {
  apiErrorResponse,
  assertFormFields,
  parseFormRequest,
} from './_http.js'
import {
  generateSchemaWithModel,
  json,
  parseInstruction,
  parseTemperature,
} from './_model.js'
import {
  formContextIdentity,
  loadOwnedSourceMarkdown,
} from './_schema_edit.js'

const FIELDS = [
  'project_context_id',
  'source_representation_revision_id',
  'instruction',
  'temperature',
] as const

type GenerateSchemaStore = Pick<
  ResearcherProjectStore,
  'getSourceRepresentation'
>

type GenerateSchema = typeof generateSchemaWithModel

export function createPostGenerateSchema(
  store: GenerateSchemaStore,
  reader: Pick<CanonicalPackageStore, 'read'> = canonicalPackageStore,
  generate: GenerateSchema = generateSchemaWithModel,
) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const form = await parseFormRequest(request)
      assertFormFields(form, FIELDS)
      const projectContextId = formContextIdentity(form, 'project_context_id')
      const sourceRepresentationRevisionId = formContextIdentity(
        form,
        'source_representation_revision_id',
      )
      const instruction = parseInstruction(form.get('instruction'))
      const temperature = parseTemperature(form.get('temperature'))
      const documentMarkdown = await loadOwnedSourceMarkdown(
        store,
        reader,
        projectContextId,
        sourceRepresentationRevisionId,
      )
      const result = await generate({
        document: {
          file: null,
          pages: null,
          markdown: documentMarkdown,
        },
        instruction,
        temperature,
        signal: request.signal,
      })
      return json(result)
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

export function createResearcherApiHandlers(
  store: ResearcherProjectStore,
): Readonly<
  Record<string, (request: Request) => Response | Promise<Response>>
> {
  return { POST: createPostGenerateSchema(store) }
}
