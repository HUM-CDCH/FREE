import { z } from 'zod'

/** A chat message before the first schema: answered as a question, kept as an instruction for generation, or, when it
 *  only declines what was offered (`none`), neither: the page points to the chat box. */
export const schemaChatReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer'), answer: z.string() }).strict(),
  z.object({ kind: z.literal('instruction') }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
])
export type SchemaChatReply = z.infer<typeof schemaChatReplySchema>

/** The schema chat so far, oldest first: every message a request's model reads besides the one it answers. A `note` is
 *  Studio's, not said by anyone: which Source Document the researcher turned to, or that earlier messages are left out. */
export const chatHistorySchema = z.array(z.object({
  role: z.enum(['user', 'assistant', 'note']),
  text: z.string(),
}).strict()).max(500)
export type ChatHistory = z.infer<typeof chatHistorySchema>
