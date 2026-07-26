import type { UIMessage } from 'ai'
import { z } from 'zod'
import { ApiError, apiErrorResponse, parseJsonRequest } from './_http.js'
import { streamChatWithModel } from './_model.js'

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
    messages: z.array(messageSchema),
    documentMarkdown: z.string(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict()

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = requestSchema.safeParse(await parseJsonRequest(request))
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_request', 'The chat request is invalid.', { cause: parsed.error })
    }
    return await streamChatWithModel(
      parsed.data.messages as UIMessage[],
      parsed.data.documentMarkdown,
      parsed.data.temperature,
    )
  } catch (error) {
    return apiErrorResponse(error)
  }
}
