import { z } from 'zod'
import { canonicalUuidSchema } from './projectContext.contract.js'

const timestamp = z.iso
  .datetime({ offset: true })
  .refine((value) => value.endsWith('Z'))

export const sourceDocumentIngestionResponseSchema = z
  .object({
    sourceDocumentId: canonicalUuidSchema,
    name: z.string(),
    createdAt: timestamp,
    sourceRepresentationId: canonicalUuidSchema,
    revisionNumber: z.literal(1),
    pageCount: z.number().int().positive(),
  })
  .strict()

export type SourceDocumentIngestionResponse = z.output<
  typeof sourceDocumentIngestionResponseSchema
>

/** What the upload POST answers once Studio admitted the attempt. The attempt may already be running or finished. */
export const sourceIngestionAdmittedSchema = z.object({ workflowId: z.string() }).strict()
export type SourceIngestionAdmitted = z.output<typeof sourceIngestionAdmittedSchema>

/** How many workflow IDs one listing request may name explicitly. */
export const MAX_NAMED_INGESTIONS = 50

const ingestionFailureSchema = z.object({ code: z.string().max(128), message: z.string().max(512) }).strict()
const common = { workflowId: z.string(), name: z.string(), createdAt: timestamp }

/**
 * One Source Ingestion as the Project page sees it. `succeeded` rows are synchronization metadata (a completion the
 * page must not miss), never cards: the branch read shows the Source Document.
 */
export const sourceIngestionSchema = z.discriminatedUnion('status', [
  z.object({ ...common, status: z.literal('queued') }).strict(),
  z.object({ ...common, status: z.literal('parsing') }).strict(),
  z.object({ ...common, status: z.literal('succeeded'), completedAt: timestamp, sourceDocumentId: canonicalUuidSchema }).strict(),
  z.object({ ...common, status: z.literal('failed'), completedAt: timestamp, failure: ingestionFailureSchema }).strict(),
])
export type SourceIngestion = z.output<typeof sourceIngestionSchema>

/** `absent`: the named workflow IDs Studio does not hold for this project (dismissed, collected, or never this project's). */
export const sourceIngestionListingSchema = z
  .object({ ingestions: z.array(sourceIngestionSchema), absent: z.array(z.string()) })
  .strict()
export type SourceIngestionListing = z.output<typeof sourceIngestionListingSchema>

export function isLiveIngestion(ingestion: SourceIngestion): boolean {
  return ingestion.status === 'queued' || ingestion.status === 'parsing'
}
