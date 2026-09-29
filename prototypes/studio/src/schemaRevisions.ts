import { authenticatedFetch } from './auth/authenticatedFetch.ts'
import type { SchemaDefinition } from 'extraction/schema'
import {
  extractionSchemaListResponseSchema,
  extractionSchemaResponseSchema,
  schemaRevisionListResponseSchema,
  schemaRevisionResponseSchema,
  schemaRevisionSchema,
  type SchemaRevision,
  type SchemaRevisionSummary,
} from '../shared/schemaRevision.contract'
import { isRecord } from '../shared/template'

export class SchemaRevisionConflictError extends Error {
  readonly currentRevision: SchemaRevision

  constructor(currentRevision: SchemaRevision) {
    super('The Current Schema Revision has changed.')
    this.name = 'SchemaRevisionConflictError'
    this.currentRevision = currentRevision
  }
}

export async function listExtractionSchemas(
  projectContextId: string,
  limit = 20,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ projectContextId, limit: String(limit) })
  const response = await authenticatedFetch(`/api/extraction-schemas?${query}`, { signal })
  const value = await body(response)
  if (!response.ok) throw failure(value, response.status)
  return extractionSchemaListResponseSchema.parse(value).extractionSchemas
}

export async function renameExtractionSchema(
  projectContextId: string,
  extractionSchemaId: string,
  name: string,
  signal?: AbortSignal,
) {
  const response = await authenticatedFetch(`/api/extraction-schemas/${extractionSchemaId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ projectContextId, name }),
    signal,
  })
  const value = await body(response)
  if (!response.ok) throw failure(value, response.status)
  return extractionSchemaResponseSchema.parse(value).extractionSchema
}

export async function deleteExtractionSchema(
  projectContextId: string,
  extractionSchemaId: string,
  signal?: AbortSignal,
): Promise<void> {
  const query = new URLSearchParams({ projectContextId })
  const response = await authenticatedFetch(
    `/api/extraction-schemas/${extractionSchemaId}?${query}`,
    { method: 'DELETE', signal },
  )
  if (response.status === 204) return
  const value = await body(response)
  throw failure(value, response.status)
}

async function body(response: Response): Promise<unknown> {
  return response.json().catch(() => null)
}

function failure(value: unknown, status: number): Error {
  const error = isRecord(value) && isRecord(value.error) ? value.error : null
  return new Error(
    error && typeof error.code === 'string' && typeof error.message === 'string'
      ? `${error.code}: ${error.message}`
      : `Schema Revision request failed (HTTP ${status})`,
  )
}

export async function listSchemaRevisions(
  projectContextId: string,
  extractionSchemaId: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<SchemaRevisionSummary[]> {
  const query = new URLSearchParams({
    projectContextId,
    extractionSchemaId,
    limit: String(limit),
  })
  const response = await authenticatedFetch(`/api/schema-revisions?${query}`, { signal })
  const value = await body(response)
  if (!response.ok) throw failure(value, response.status)
  return schemaRevisionListResponseSchema.parse(value).revisions
}

export async function getSchemaRevision(
  projectContextId: string,
  extractionSchemaId: string,
  schemaRevisionId: string,
  signal?: AbortSignal,
): Promise<SchemaRevision> {
  const query = new URLSearchParams({ projectContextId, extractionSchemaId })
  const response = await authenticatedFetch(`/api/schema-revisions/${schemaRevisionId}?${query}`,
  { signal },)
  const value = await body(response)
  if (!response.ok) throw failure(value, response.status)
  return schemaRevisionResponseSchema.parse(value).revision
}

async function writeSchemaRevision(
  request: object,
  signal?: AbortSignal,
): Promise<SchemaRevision> {
  const response = await authenticatedFetch('/api/schema-revisions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  const value = await body(response)
  if (response.status === 409 && isRecord(value) && isRecord(value.error)) {
    const conflict = schemaRevisionSchema.safeParse(
      isRecord(value.error.details)
        ? value.error.details.currentRevision
        : undefined,
    )
    if (value.error.code === 'revision_conflict' && conflict.success)
      throw new SchemaRevisionConflictError(conflict.data)
  }
  if (!response.ok) throw failure(value, response.status)
  return schemaRevisionResponseSchema.parse(value).revision
}

export function initializeSchemaRevision(
  projectContextId: string,
  definition: SchemaDefinition,
  signal?: AbortSignal,
): Promise<SchemaRevision> {
  return writeSchemaRevision({ projectContextId, ...definition }, signal)
}

export function appendSchemaRevision(
  projectContextId: string,
  extractionSchemaId: string,
  expectedRevisionNumber: number,
  definition: SchemaDefinition,
  signal?: AbortSignal,
): Promise<SchemaRevision> {
  return writeSchemaRevision(
    { projectContextId, extractionSchemaId, expectedRevisionNumber, ...definition },
    signal,
  )
}
