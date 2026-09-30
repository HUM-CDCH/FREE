import { z } from 'zod'
import { canonicalUuidSchema } from './projectContext.contract.js'

export const sampleFactsRequest = z.object({
  projectContextId: canonicalUuidSchema, schemaRevisionId: canonicalUuidSchema,
  sourceDocumentIds: z.array(canonicalUuidSchema).min(1).max(50).refine((ids) => new Set(ids).size === ids.length),
}).strict()
export const sampleFactsResponse = z.object({ sources: z.array(z.object({
  sourceDocumentId: canonicalUuidSchema, sourceRepresentationRevisionId: canonicalUuidSchema.nullable(),
  admitted: z.int().nonnegative(), savedDrafts: z.int().nonnegative(), finalized: z.int().nonnegative(), fullResults: z.int().nonnegative(),
  pages: z.array(z.int().positive()), reviewedPages: z.array(z.int().positive()),
}).strict()) }).strict()
export type SampleFacts = z.infer<typeof sampleFactsResponse>
