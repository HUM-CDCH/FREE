import { z } from 'zod'
import { canonicalUuidSchema } from './projectContext.contract.js'

/**
 * Marks a piloted Schema Revision stabilised, unlocking batch/collection-level
 * extraction against it (guided-pilot-extraction-workflow, guided-workflow-phases).
 */
export const stabiliseSchemaRevisionRequestSchema = z
  .object({
    projectContextId: canonicalUuidSchema,
    schemaRevisionId: canonicalUuidSchema,
  })
  .strict()

export type StabiliseSchemaRevisionRequest = z.infer<
  typeof stabiliseSchemaRevisionRequestSchema
>

export const stabiliseSchemaRevisionResponseSchema = z
  .object({
    schemaRevisionId: canonicalUuidSchema,
    stabilisedAt: z.string(),
  })
  .strict()

export type StabiliseSchemaRevisionResponse = z.infer<
  typeof stabiliseSchemaRevisionResponseSchema
>
