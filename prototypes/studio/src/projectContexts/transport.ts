import {
  REPROCESS_TERMINAL_HEADER,
  sourceDocumentReprocessResponseSchema,
  type SourceDocumentReprocessRequest,
} from '../../shared/sourceDocumentReprocess.contract'
import { authenticatedFetch } from '../auth/authenticatedFetch.ts'
import type { z } from 'zod'
import {
  documentReopenResponseSchema,
  projectContextErrorResponseSchema,
  projectContextErrorSchema,
  projectContextListItemSchema,
  projectContextListResponseSchema,
  projectContextResponseSchema,
  projectContextWithDocumentsResponseSchema,
} from '../../shared/projectContext.contract'
import {
  sourceDocumentIngestionResponseSchema,
  sourceIngestionAdmittedSchema,
  sourceIngestionListingSchema,
  type SourceDocumentIngestionResponse,
  type SourceIngestionListing,
} from '../../shared/sourceDocumentIngestion.contract'
import type { SourceLayout } from '../sourceIngestionMachine'

export type ProjectContext = z.output<typeof projectContextListItemSchema>
export type ProjectContextActivitySummary = ProjectContext['summary']
export type ProjectContextActivityEvent = z.output<
  typeof projectContextListResponseSchema
>['recentActivity'][number]

/**
 * A placeholder summary for a Project Context entered into the list before a
 * server list read carries its authoritative one — a just-created Project
 * Context, or a routed one resolved from its branch read. The next list read
 * replaces it.
 */
export function provisionalSummary(
  createdAt: string,
  sourceDocumentCount: number,
): ProjectContextActivitySummary {
  return {
    phase: sourceDocumentCount > 0 ? 'chat' : 'ingest',
    extractionCount: 0,
    extractedSourceDocumentCount: 0,
    reviewedSourceDocumentCount: 0,
    staleSourceDocumentCount: 0,
    schemaDraftCount: 0,
    schemaStabilised: false,
    lastActivityAt: createdAt,
    runningBatch: null,
  }
}
export type ProjectContextDetail = z.output<
  typeof projectContextWithDocumentsResponseSchema
>
export type ProjectContextFailure = z.output<typeof projectContextErrorSchema>
/** The durable read that reopens a Source Document, as the browser receives it. */
export type DocumentSnapshot = z.output<typeof documentReopenResponseSchema>

/** A request the server answered with an error status: the status, and its bounded failure when it sent one. */
export class ProjectContextRequestError extends Error {
  readonly status: number
  readonly failure: ProjectContextFailure | null
  readonly terminalOutcome: boolean

  constructor(status: number, failure: ProjectContextFailure | null, terminalOutcome = false) {
    super(failure?.message ?? 'Project Context request failed.')
    this.name = 'ProjectContextRequestError'
    this.status = status
    this.failure = failure
    this.terminalOutcome = terminalOutcome
  }
}

async function readResponse(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await authenticatedFetch(url, init)
  const body: unknown =
    response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const error = projectContextErrorResponseSchema.safeParse(body)
    throw new ProjectContextRequestError(
      response.status, error.success ? error.data.error : null,
      response.headers.get(REPROCESS_TERMINAL_HEADER) === '1',
    )
  }
  return { status: response.status, body }
}

async function read(url: string, init?: RequestInit): Promise<unknown> {
  return (await readResponse(url, init)).body
}

/** Statuses after which the server may still have done, or still be doing, the work. */
const UNCERTAIN_STATUSES = new Set([502, 503, 504])

/**
 * Whether a failed request left its outcome unknown: no answer at all (a network error) or a gateway, unavailable or
 * timeout status. Repeating such a request with the same key replays whatever the server did; any other refusal is
 * confirmed, and a retry is a new action (spec, *Client IDs*).
 */
export function uncertainFailure(error: unknown): boolean {
  return !(error instanceof ProjectContextRequestError) || (!error.terminalOutcome && UNCERTAIN_STATUSES.has(error.status))
}

async function request<T>(
  url: string,
  schema: { parse(value: unknown): T },
  signal?: AbortSignal,
): Promise<T> {
  return schema.parse(await read(url, { signal }))
}

async function write(url: string, method: 'POST' | 'PATCH', name: string) {
  return projectContextResponseSchema.parse(
    await read(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  ).projectContext
}

export function createProjectContext(name: string) {
  return write('/api/project-contexts', 'POST', name)
}

export function renameProjectContext(projectContextId: string, name: string) {
  return write(`/api/project-contexts/${projectContextId}`, 'PATCH', name)
}

export async function deleteProjectContext(
  projectContextId: string,
): Promise<void> {
  await read(`/api/project-contexts/${projectContextId}`, { method: 'DELETE' })
}

export async function deleteSourceDocument(
  projectContextId: string,
  sourceDocumentId: string,
): Promise<void> {
  await read(
    `/api/project-contexts/${projectContextId}/source-documents/${sourceDocumentId}`,
    { method: 'DELETE' },
  )
}

/** A read failure that is not one of the bounded codes is unreadable persistence. */
export function toProjectContextFailure(error: unknown): ProjectContextFailure {
  if (error instanceof ProjectContextRequestError && error.failure) return error.failure
  const parsed = projectContextErrorSchema.safeParse(error)
  if (parsed.success) return parsed.data
  return {
    code: 'persistence_unavailable',
    message: 'Project Context storage is unavailable.',
  }
}

/** The list plus the researcher's latest persisted activity in one read. */
export async function listProjectContexts(signal: AbortSignal) {
  return request(
    '/api/project-contexts',
    projectContextListResponseSchema,
    signal,
  )
}

// No signal: branch reads fill an id-keyed cache and intentionally outlive
// collapse and unmount; a generation fence, not an abort, keeps them honest.
export async function getProjectContextWithDocuments(
  projectContextId: string,
): Promise<ProjectContextDetail> {
  return request(
    `/api/project-contexts/${projectContextId}`,
    projectContextWithDocumentsResponseSchema,
  )
}

export type UploadAdmission =
  | { kind: 'admitted'; workflowId: string }
  | { kind: 'replayed'; document: SourceDocumentIngestionResponse }

/**
 * Sends one PDF and its page layout. It carries no key: the server identifies an upload by its content. Studio answers
 * once the attempt is admitted (202, its workflow ID; the same bytes sent again join the attempt still running), or at
 * once with the Source Document the bytes already became (201).
 */
export async function ingestSourceDocument(
  projectContextId: string,
  file: File,
  layout: SourceLayout = 'pages',
  signal?: AbortSignal,
): Promise<UploadAdmission> {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('layout', layout)
  const { status, body } = await readResponse(`/api/project-contexts/${projectContextId}/source-documents`, {
    method: 'POST',
    body: form,
    signal,
  })
  if (status === 202) return { kind: 'admitted', workflowId: sourceIngestionAdmittedSchema.parse(body).workflowId }
  if (status === 201) return { kind: 'replayed', document: sourceDocumentIngestionResponseSchema.parse(body) }
  throw new ProjectContextRequestError(status, null)
}

/** The Project Context's Source Ingestions, plus the named workflow IDs whatever their age (or listed as absent). */
export async function listSourceIngestions(
  projectContextId: string,
  workflowIds: readonly string[],
  signal?: AbortSignal,
): Promise<SourceIngestionListing> {
  const query = new URLSearchParams(workflowIds.map((id) => ['workflowId', id])).toString()
  return request(
    `/api/project-contexts/${projectContextId}/source-ingestions${query ? `?${query}` : ''}`,
    sourceIngestionListingSchema,
    signal,
  )
}

export async function dismissSourceIngestion(projectContextId: string, workflowId: string): Promise<void> {
  await read(`/api/project-contexts/${projectContextId}/source-ingestions/${encodeURIComponent(workflowId)}`, {
    method: 'DELETE',
  })
}

export function getDocumentReopenSnapshot(
  projectContextId: string,
  sourceDocumentId: string,
  signal?: AbortSignal,
  extractionId?: string,
): Promise<DocumentSnapshot> {
  const query = extractionId
    ? `?${new URLSearchParams({ extractionId })}`
    : ''
  return request(
    `/api/project-contexts/${projectContextId}/source-documents/${sourceDocumentId}/reopen${query}`,
    documentReopenResponseSchema,
    signal,
  )
}

export async function reprocessSourceDocument(
  projectContextId: string,
  sourceDocumentId: string,
  input: SourceDocumentReprocessRequest,
) {
  return sourceDocumentReprocessResponseSchema.parse(
    await read(
      `/api/project-contexts/${projectContextId}/source-documents/${sourceDocumentId}/reprocess`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    ),
  )
}
