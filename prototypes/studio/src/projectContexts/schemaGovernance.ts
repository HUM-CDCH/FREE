import { authenticatedFetch } from '../auth/authenticatedFetch.ts'
import {
  schemaIssueFlagListResponseSchema,
  schemaIssueFlagResponseSchema,
  type SchemaIssueFlagRequest,
} from '../../shared/schemaIssueFlag.contract'
import {
  stabiliseSchemaRevisionResponseSchema,
  type StabiliseSchemaRevisionRequest,
} from '../../shared/stabiliseSchemaRevision.contract'
import { isRecord } from '../../shared/template'

/** Carries the server's error `code` so callers can react to a specific
 *  failure (e.g. `schema_not_ready_to_stabilise`) instead of string-matching
 *  a message (guided-pilot-extraction-workflow). */
export class SchemaGovernanceRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'SchemaGovernanceRequestError'
    this.status = status
    this.code = code
  }
}

async function read(url: string, init?: RequestInit): Promise<unknown> {
  const response = await authenticatedFetch(url, init)
  const value: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = isRecord(value) && isRecord(value.error) ? value.error : null
    throw new SchemaGovernanceRequestError(
      response.status,
      typeof error?.code === 'string' ? error.code : 'unexpected_failure',
      typeof error?.message === 'string'
        ? error.message
        : `Request failed (HTTP ${response.status}).`,
    )
  }
  return value
}

/** Marks a piloted Schema Revision stabilised, unlocking collection-scale
 *  Batch Extraction against it. Rejects with `schema_not_ready_to_stabilise`
 *  until at least one pilot Extraction has been reviewed. */
export async function stabiliseSchemaRevision(
  request: StabiliseSchemaRevisionRequest,
  signal?: AbortSignal,
) {
  return stabiliseSchemaRevisionResponseSchema.parse(
    await read('/api/stabilise_schema_revision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
      signal,
    }),
  )
}

export async function listOpenSchemaIssueFlags(
  projectContextId: string,
  schemaRevisionId: string,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ projectContextId, schemaRevisionId })
  return schemaIssueFlagListResponseSchema.parse(
    await read(`/api/schema_issue_flags?${query}`, { signal }),
  ).flags
}

/** Flags one schema field as problematic, scoped to the given Schema
 *  Revision. Idempotent per `(schemaRevisionId, fieldPath)`. */
export async function flagSchemaField(
  request: SchemaIssueFlagRequest,
  signal?: AbortSignal,
) {
  return schemaIssueFlagResponseSchema.parse(
    await read('/api/schema_issue_flags', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
      signal,
    }),
  ).flag
}
