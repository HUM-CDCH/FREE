import type { UIMessage } from 'ai'
import {
  canonicalPackageStore,
  type CanonicalPackageStore,
} from '../../../packages/db/src/artifact-store.js'
import type { ResearcherProjectStore } from '../../../packages/db/src/project-store.js'
import { z } from 'zod'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import { ApiError, apiErrorResponse, parseJsonRequest } from './_http.js'
import { streamChatWithModel } from './_model.js'
import { loadOwnedSourceMarkdown } from './_schema_edit.js'

const textPartSchema = z.object({ type: z.literal('text'), text: z.string() }).strict()
const filePartSchema = z
  .object({
    type: z.literal('file'),
    mediaType: z.string(),
    filename: z.string().optional(),
    url: z.string(),
  })
  .strict()
const messageSchema = z
  .object({
    id: z.string(),
    role: z.enum(['system', 'user', 'assistant']),
    parts: z.array(z.union([textPartSchema, filePartSchema])),
  })
  .strict()
const requestSchema = z
  .object({
    projectContextId: canonicalUuidSchema,
    sourceRepresentationRevisionId: canonicalUuidSchema,
    messages: z.array(messageSchema),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict()

type ChatStore = Pick<ResearcherProjectStore, 'researcherAccountId' | 'getSourceRepresentation'>
type StreamChat = typeof streamChatWithModel

export function createPostChat(
  store: ChatStore,
  reader: Pick<CanonicalPackageStore, 'read'> = canonicalPackageStore,
  stream: StreamChat = streamChatWithModel,
) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const parsed = requestSchema.safeParse(await parseJsonRequest(request))
      if (!parsed.success)
        throw new ApiError(
          400,
          'invalid_request',
          'The chat request is invalid.',
          { cause: parsed.error },
        )
      const documentMarkdown = await loadOwnedSourceMarkdown(
        store,
        reader,
        parsed.data.projectContextId,
        parsed.data.sourceRepresentationRevisionId,
      )
      return await stream(
        { researcherAccountId: store.researcherAccountId },
        parsed.data.messages as UIMessage[],
        documentMarkdown,
        parsed.data.temperature,
        request.signal,
      )
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
  return { POST: createPostChat(store) }
}
