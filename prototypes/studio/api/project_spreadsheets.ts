import type { ResearcherProjectStore, ProjectSpreadsheetVersionRecord } from 'db'
import {
  projectSpreadsheetVersionResponseSchema,
} from '../shared/projectSpreadsheet.contract.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import {
  ApiError,
  assertFormFields,
  json,
  noStore,
  noStoreError,
  parseFormRequest,
  persistenceUnavailable,
} from './_http.js'
import { parseSpreadsheetColumns } from './_spreadsheet_schema.js'

const ROUTE = '/api/project-spreadsheets'

function projectSpreadsheetVersionDto(version: ProjectSpreadsheetVersionRecord) {
  return projectSpreadsheetVersionResponseSchema.parse({
    projectSpreadsheetVersion: {
      projectSpreadsheetVersionId: version.projectSpreadsheetVersionId,
      projectContextId: version.projectContextId,
      revisionNumber: version.revisionNumber,
      originalFilename: version.originalFilename,
      columns: version.columns,
      createdAt: version.createdAt.toISOString(),
    },
  })
}

function projectId(url: URL): string {
  const value = url.searchParams.get('projectContextId')
  const parsed = canonicalUuidSchema.safeParse(value)
  if (!parsed.success)
    throw new ApiError(422, 'invalid_request', 'projectContextId is required.')
  return parsed.data
}

/**
 * The project's single shared spreadsheet slot: uploading appends a new
 * version (never replaces one), and `schema-suggestion`'s from-spreadsheet
 * flow (and, later, gold-standard-corpus population) reads whichever
 * version is current at the time — reused across actions rather than
 * uploaded fresh for each one (spreadsheet-schema-suggestion design.md,
 * "spreadsheet upload is the ingestion mechanism").
 */
export function createResearcherApiHandlers(
  store: ResearcherProjectStore,
): Readonly<Record<string, (request: Request) => Response | Promise<Response>>> {
  const upload = async (request: Request) => {
    const form = await parseFormRequest(request)
    assertFormFields(form, ['file', 'projectContextId'])
    const file = form.get('file')
    const projectContextIdValue = form.get('projectContextId')
    if (!(file instanceof File))
      throw new ApiError(400, 'invalid_request', 'A spreadsheet file is required.')
    const projectContextId = canonicalUuidSchema.safeParse(projectContextIdValue)
    if (!projectContextId.success)
      throw new ApiError(422, 'invalid_request', 'projectContextId is required.')

    const columns = await parseSpreadsheetColumns(await file.arrayBuffer()).catch(
      (cause) => {
        throw new ApiError(400, 'invalid_request', 'The spreadsheet could not be read.', { cause })
      },
    )
    const appended = await store
      .appendProjectSpreadsheetVersion(projectContextId.data, file.name, columns)
      .catch((cause) => {
        throw persistenceUnavailable(cause)
      })
    if (!appended)
      throw new ApiError(404, 'not_found', 'Project Context was not found.')
    return json(projectSpreadsheetVersionDto(appended), { status: 201, headers: noStore })
  }

  const read = async (url: URL) => {
    const current = await store
      .getCurrentProjectSpreadsheet(projectId(url))
      .catch((cause) => {
        throw persistenceUnavailable(cause)
      })
    return json(
      projectSpreadsheetVersionResponseSchema.parse({
        projectSpreadsheetVersion: current
          ? projectSpreadsheetVersionDto(current).projectSpreadsheetVersion
          : null,
      }),
      { headers: noStore },
    )
  }

  const handle = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url)
      if (url.pathname !== ROUTE) throw new ApiError(404, 'not_found', 'API route not found.')
      if (request.method === 'POST') return await upload(request)
      if (request.method === 'GET') return await read(url)
      throw new ApiError(404, 'not_found', 'API route not found.')
    } catch (error) {
      return noStoreError(error)
    }
  }

  return { GET: handle, POST: handle }
}
