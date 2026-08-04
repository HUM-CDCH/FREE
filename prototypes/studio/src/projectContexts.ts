import type { z } from 'zod'
import {
  projectContextErrorResponseSchema,
  projectContextListResponseSchema,
  projectContextWithDocumentsResponseSchema,
} from '../shared/projectContext.contract'

async function request<T>(
  url: string,
  schema: { parse(value: unknown): T },
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, { signal })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = projectContextErrorResponseSchema.safeParse(body)
    if (error.success) throw error.data.error
    throw new Error('Project Context request failed.')
  }
  return schema.parse(body)
}

export async function listProjectContexts(signal: AbortSignal) {
  return (
    await request('/api/project-contexts', projectContextListResponseSchema, signal)
  ).projectContexts
}

export function getProjectContextWithDocuments(
  projectContextId: string,
): Promise<z.output<typeof projectContextWithDocumentsResponseSchema>> {
  return request(
    `/api/project-contexts/${projectContextId}`,
    projectContextWithDocumentsResponseSchema,
  )
}
