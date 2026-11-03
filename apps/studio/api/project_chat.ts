import type { ProjectChatEntryRecord as StoredEntry, ResearcherProjectStore } from 'db'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import {
  PROJECT_CHAT_READ_LIMIT,
  projectChatAppendRequestSchema,
  projectChatEntrySchema,
  projectChatResponseSchema,
} from '../shared/projectChat.contract.js'
import { ApiError, json, noStore, noStoreError, parseJsonRequest, persistenceUnavailable } from './_http.js'

const ROUTE = /^\/api\/project-contexts\/([^/]+)\/chat(?:\/([^/]+))?$/

/** The Project Context and, for DELETE, the entry the path names, each a canonical UUID. */
function target(request: Request): { projectContextId: string; entryId: string | null } {
  const match = ROUTE.exec(new URL(request.url).pathname)
  if (!match) throw new ApiError(404, 'not_found', 'Project chat route was not found.')
  const [, projectContextId = '', entryId = null] = match
  if (!canonicalUuidSchema.safeParse(projectContextId).success || (entryId !== null && !canonicalUuidSchema.safeParse(entryId).success))
    throw new ApiError(422, 'invalid_request', 'The Project Context and chat entry IDs must be canonical lowercase UUIDs.')
  return { projectContextId, entryId }
}

const missing = () => new ApiError(404, 'not_found', 'Project Context was not found.')

/** An entry as stored: one this Studio no longer reads is left out, not failed on. */
const entries = (stored: readonly StoredEntry[]) => stored.flatMap(({ projectChatEntryId, position, entry, createdAt }) => {
  const parsed = projectChatEntrySchema.safeParse(entry)
  return parsed.success ? [{ projectChatEntryId, position, entry: parsed.data, createdAt: createdAt.toISOString() }] : []
})

/**
 * A Project Context's chat, kept with the project so it outlives the page that showed it: GET reads its latest entries,
 * POST appends, DELETE removes the one entry a researcher can take back (a kept instruction). Owner-scoped like every
 * project read.
 */
export function createResearcherApiHandlers(
  store: Pick<ResearcherProjectStore, 'listProjectChatEntries' | 'appendProjectChatEntries' | 'deleteProjectChatEntry'>,
): Readonly<Record<string, (request: Request) => Response | Promise<Response>>> {
  const unavailable = (cause: unknown): never => { throw persistenceUnavailable(cause) }
  return {
    GET: async (request) => {
      try {
        const { projectContextId, entryId } = target(request)
        if (entryId !== null) throw new ApiError(404, 'not_found', 'Project chat route was not found.')
        const stored = await store.listProjectChatEntries(projectContextId, PROJECT_CHAT_READ_LIMIT).catch(unavailable)
        if (!stored) throw missing()
        return json(projectChatResponseSchema.parse({ entries: entries(stored) }), { headers: noStore })
      } catch (error) {
        return noStoreError(error)
      }
    },
    POST: async (request) => {
      try {
        const { projectContextId, entryId } = target(request)
        if (entryId !== null) throw new ApiError(404, 'not_found', 'Project chat route was not found.')
        const body = projectChatAppendRequestSchema.safeParse(await parseJsonRequest(request))
        if (!body.success) throw new ApiError(422, 'invalid_request', 'entries must list chat entries to append.')
        const stored = await store.appendProjectChatEntries(projectContextId, body.data.entries).catch(unavailable)
        if (!stored) throw missing()
        return json(projectChatResponseSchema.parse({ entries: entries(stored) }), { status: 201, headers: noStore })
      } catch (error) {
        return noStoreError(error)
      }
    },
    DELETE: async (request) => {
      try {
        const { projectContextId, entryId } = target(request)
        if (entryId === null) throw new ApiError(404, 'not_found', 'Project chat route was not found.')
        const removed = await store.deleteProjectChatEntry(projectContextId, entryId).catch(unavailable)
        if (removed === null) throw missing()
        if (!removed) throw new ApiError(404, 'not_found', 'Chat entry was not found.')
        return new Response(null, { status: 204, headers: noStore })
      } catch (error) {
        return noStoreError(error)
      }
    },
  }
}
