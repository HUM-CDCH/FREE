import { CANONICAL_UUID_PATTERN } from 'studio-configuration'
import { z } from 'zod'
import { canonicalUuidSchema } from './projectContext.contract'
import { schemaEditResponseSchema } from './schemaEdit.contract'
import { sourceCoverageSchema } from './schemaSuggestionSource.contract'

/** A generation or edit operation's workflow ID (spec, *Workflows*); full match, no `m` flag. */
export const MODEL_OPERATION_WORKFLOW_ID = new RegExp(`^(suggestion|edit):(${CANONICAL_UUID_PATTERN})$`)

const failureSchema = z.object({ code: z.string(), message: z.string() }).strict()
const common = {
  workflowId: z.string(),
  operationId: canonicalUuidSchema,
  /** QUEUED/RUNNING while the workflow is live; SUCCEEDED when it returned `ok: true`; FAILED otherwise, including a
   *  stop (cancel, crash beyond recovery, history gone), whose failure is `interrupted`. */
  status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']),
  instruction: z.string(),
  createdAt: z.string(),
  failure: failureSchema.nullable(),
}
export const modelOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('generation'),
    ...common,
    baseSchemaRevisionId: canonicalUuidSchema.nullable(),
    template: z.record(z.string(), z.unknown()).nullable(),
    /** What the generation's model call read of the source; null while unfinished or when not recorded. */
    sourceCoverage: sourceCoverageSchema.nullable(),
  }).strict(),
  z.object({
    kind: z.literal('proposal'),
    ...common,
    baseSchemaRevisionId: canonicalUuidSchema,
    response: schemaEditResponseSchema.nullable(),
  }).strict(),
])
export const modelOperationListingSchema = z.object({ operations: z.array(modelOperationSchema).max(20) }).strict()
export type ModelOperation = z.infer<typeof modelOperationSchema>
export type ModelOperationListing = z.infer<typeof modelOperationListingSchema>
