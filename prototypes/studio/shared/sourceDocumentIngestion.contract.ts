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
  })
  .strict()

export type SourceDocumentIngestionResponse = z.output<
  typeof sourceDocumentIngestionResponseSchema
>
