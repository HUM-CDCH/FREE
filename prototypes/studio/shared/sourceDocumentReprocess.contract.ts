import { z } from 'zod'
import { canonicalUuidSchema } from './projectContext.contract.js'
import { sourceDocumentIngestionResponseSchema } from './sourceDocumentIngestion.contract.js'

export const sourceDocumentReprocessRequestSchema = z
  .object({
    requestKey: canonicalUuidSchema,
    expectedRepresentationId: canonicalUuidSchema,
    layout: z.enum(['pages', 'spreads']),
  })
  .strict()
export const sourceDocumentReprocessResponseSchema =
  sourceDocumentIngestionResponseSchema.extend({
    revisionNumber: z.number().int().positive(),
  })
export type SourceDocumentReprocessRequest = z.output<
  typeof sourceDocumentReprocessRequestSchema
>
export type SourceDocumentReprocessResponse = z.output<
  typeof sourceDocumentReprocessResponseSchema
>
