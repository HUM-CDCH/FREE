import { z } from 'zod'
import { canonicalUuidSchema } from './projectContext.contract.js'

const timestamp = z.iso.datetime({ offset: true }).refine((value) => value.endsWith('Z'))

/** The longest text one entry keeps: a model's answer, or a message the researcher wrote. */
export const PROJECT_CHAT_TEXT_LIMIT = 20_000
/** The most entries one append carries: a message and what answers it. */
export const PROJECT_CHAT_APPEND_LIMIT = 20
/** The latest entries a reopened chat shows; older ones stay stored, unread. */
export const PROJECT_CHAT_READ_LIMIT = 1_000

const text = z.string().min(1).max(PROJECT_CHAT_TEXT_LIMIT)

/**
 * One entry of a Project Context's chat. A `message` is said in the chat once a template exists; an `instruction` is a
 * message before it, kept to steer generation, or with its `answer` a question answered; a `step` is a guided step's
 * answer (its title and the choice made); a `document` is the Source Document the researcher turned to.
 */
export const projectChatEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), role: z.enum(['user', 'assistant']), text }).strict(),
  z.object({ kind: z.literal('instruction'), text, answer: text.optional() }).strict(),
  z.object({ kind: z.literal('step'), title: z.string().min(1).max(500), choice: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal('document'), sourceDocumentId: canonicalUuidSchema, name: z.string().min(1).max(500) }).strict(),
])
export type ProjectChatEntry = z.output<typeof projectChatEntrySchema>

export const projectChatEntryRecordSchema = z
  .object({ projectChatEntryId: canonicalUuidSchema, position: z.number().int().positive(), entry: projectChatEntrySchema, createdAt: timestamp })
  .strict()
export type ProjectChatEntryRecord = z.output<typeof projectChatEntryRecordSchema>

/** Entries to append, in order, each with the ID its sender gave it: a repeated append adds none twice. */
export const projectChatAppendRequestSchema = z
  .object({
    entries: z.array(z.object({ projectChatEntryId: canonicalUuidSchema, entry: projectChatEntrySchema }).strict())
      .min(1).max(PROJECT_CHAT_APPEND_LIMIT),
  })
  .strict()
export type ProjectChatAppendRequest = z.output<typeof projectChatAppendRequestSchema>

export const projectChatResponseSchema = z.object({ entries: z.array(projectChatEntryRecordSchema) }).strict()
