import { z } from 'zod'

/**
 * What a chat message asks Studio to do rather than answer or change (ADR 0034): make the template (again), run the
 * extraction, or go ahead with what the chat's step offers. The page decides what each does in the state it is in.
 */
export const chatRequestActionSchema = z.enum(['generate', 'extract', 'confirm'])
export type ChatRequestAction = z.infer<typeof chatRequestActionSchema>
/** The longest description of what the chat offers beside a message: its step's title and question. */
export const CHAT_OFFER_LIMIT = 2_000

/** A chat message before the first schema: answered as a question, kept as an instruction for generation, a request
 *  (`requested`, with what a template asked for should hold as its `focus`), or, when it only declines what was offered
 *  (`none`), neither: the page points to the chat box. */
export const schemaChatReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer'), answer: z.string() }).strict(),
  z.object({ kind: z.literal('instruction') }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('requested'), action: chatRequestActionSchema, focus: z.string().nullable() }).strict(),
])
export type SchemaChatReply = z.infer<typeof schemaChatReplySchema>

/** The schema chat so far, oldest first: every message a request's model reads besides the one it answers. A `note` is
 *  Studio's, not said by anyone: which Source Document the researcher turned to, or that earlier messages are left out. */
export const chatHistorySchema = z.array(z.object({
  role: z.enum(['user', 'assistant', 'note']),
  text: z.string(),
}).strict()).max(500)
export type ChatHistory = z.infer<typeof chatHistorySchema>
