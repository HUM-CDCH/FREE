import { z } from 'zod'

/** A chat message before the first schema: answered as a question, or kept as an instruction for generation. */
export const schemaChatReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer'), answer: z.string() }).strict(),
  z.object({ kind: z.literal('instruction') }).strict(),
])
export type SchemaChatReply = z.infer<typeof schemaChatReplySchema>
