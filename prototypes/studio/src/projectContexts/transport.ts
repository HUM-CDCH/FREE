import type { z } from 'zod'
import {
  documentReopenResponseSchema,
  projectContextErrorResponseSchema,
  projectContextErrorSchema,
  projectContextListResponseSchema,
  projectContextResponseSchema,
  projectContextSummarySchema,
  projectContextWithDocumentsResponseSchema,
} from '../../shared/projectContext.contract'

export type ProjectContext = z.output<typeof projectContextSummarySchema>
export type ProjectContextDetail = z.output<
  typeof projectContextWithDocumentsResponseSchema
>
export type ProjectContextFailure = z.output<typeof projectContextErrorSchema>
/** The durable read that reopens a Source Document, as the browser receives it. */
export type DocumentSnapshot = z.output<typeof documentReopenResponseSchema>

async function read(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init)
  const body: unknown =
    response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const error = projectContextErrorResponseSchema.safeParse(body)
    if (error.success) throw error.data.error
    throw new Error('Project Context request failed.')
  }
  return body
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

/** A read failure that is not one of the bounded codes is unreadable persistence. */
export function toProjectContextFailure(error: unknown): ProjectContextFailure {
  const parsed = projectContextErrorSchema.safeParse(error)
  if (parsed.success) return parsed.data
  return {
    code: 'persistence_unavailable',
    message: 'Project Context storage is unavailable.',
  }
}

export async function listProjectContexts(signal: AbortSignal) {
  return (
    await request(
      '/api/project-contexts',
      projectContextListResponseSchema,
      signal,
    )
  ).projectContexts
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

export function getDocumentReopenSnapshot(
  projectContextId: string,
  sourceDocumentId: string,
  signal?: AbortSignal,
): Promise<DocumentSnapshot> {
  return request(
    `/api/project-contexts/${projectContextId}/source-documents/${sourceDocumentId}/reopen`,
    documentReopenResponseSchema,
    signal,
  )
}
