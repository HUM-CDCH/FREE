import { modelError, streamChatWithModel } from './_model'
import { z } from 'zod'

const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

const filePartSchema = z.object({
  type: z.literal('file'),
  mediaType: z.string(),
  filename: z.string().optional(),
  url: z.string(),
})

const messageSchema = z.object({
  id: z.string(),
  role: z.enum(['system', 'user', 'assistant']),
  parts: z.array(z.union([textPartSchema, filePartSchema])),
})

const requestSchema = z.object({
  messages: z.array(messageSchema),
})

export async function POST(request: Request): Promise<Response> {
  try {
    const { messages } = requestSchema.parse(await request.json())
    return await streamChatWithModel(messages)
  } catch (error) {
    return modelError(error)
  }
}
