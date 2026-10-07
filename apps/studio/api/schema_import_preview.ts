import type { ResearcherProjectStore } from 'db'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import { previewWorkbook, SchemaImportError } from './_schema_import.js'
import { IMPORT_LIMITS } from '../shared/schemaImport.js'
import { ApiError, json, noStore, noStoreError, persistenceUnavailable } from './_http.js'

export function createResearcherApiHandlers(store: ResearcherProjectStore) {
  return { POST: async (request: Request) => {
    try {
      const url = new URL(request.url), project = url.searchParams.get('projectContextId')
      if (!canonicalUuidSchema.safeParse(project).success || !/\.xlsx$/i.test(url.searchParams.get('filename') ?? ''))
        throw new ApiError(422, 'invalid_request', 'Choose a project and an ordinary .xlsx workbook.')
      if (!await store.getProjectContextWithDocuments(project!).catch((cause) => { throw persistenceUnavailable(cause) }))
        throw new ApiError(404, 'not_found', 'The Project Context was not found.')
      const reader = request.body?.getReader(), chunks: Uint8Array[] = []
      let size = 0
      if (!reader) throw new ApiError(422, 'invalid_request', 'Choose a workbook.')
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.length
          if (size > IMPORT_LIMITS.compressed) throw new ApiError(413, 'invalid_request', 'Workbook exceeds 5 MiB compressed input.')
          chunks.push(value)
        }
      } finally { await reader.cancel(); reader.releaseLock() }
      try {
        const preview = await previewWorkbook(Buffer.concat(chunks), url.searchParams.get('worksheet'), Number(url.searchParams.get('headerRow') ?? 1))
        return json(preview, { headers: noStore })
      } catch (error) { throw new ApiError(422, 'invalid_request', error instanceof SchemaImportError ? error.message : 'Unsupported or malformed .xlsx workbook.') }
    } catch (error) { return noStoreError(error) }
  } }
}
