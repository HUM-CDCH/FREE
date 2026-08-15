import { z } from 'zod'
import { BATCH_EXTRACTION_SELECTION_LIMIT } from './batchExtraction.contract.js'
import { canonicalUuidSchema } from './projectContext.contract.js'
import { schemaDefinitionSchema } from './schemaNode.js'

const sourceDocumentIdsSchema = z
  .array(canonicalUuidSchema)
  .min(1)
  .max(BATCH_EXTRACTION_SELECTION_LIMIT)
  .refine((ids) => new Set(ids).size === ids.length)

const selectionKeySchema = z.string().regex(/^[a-f0-9]{64}$/)

export const batchSchemaSuggestionRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('merge'),
      projectContextId: canonicalUuidSchema,
      sourceDocumentIds: sourceDocumentIdsSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('confirm'),
      projectContextId: canonicalUuidSchema,
      sourceDocumentIds: sourceDocumentIdsSchema,
      selectionKey: selectionKeySchema,
      ...schemaDefinitionSchema.shape,
    })
    .strict(),
])

const coverageSchema = z
  .object({
    nodeId: z.string().min(1),
    present: z.number().int().nonnegative(),
    total: z.number().int().positive(),
  })
  .strict()

export const batchSchemaSuggestionMergeResponseSchema = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('ready'),
        selectionKey: selectionKeySchema,
        ...schemaDefinitionSchema.shape,
        coverage: z.array(coverageSchema),
      })
      .strict(),
    z
      .object({
        status: z.literal('heterogeneous'),
        selectionKey: selectionKeySchema,
      })
      .strict(),
  ],
)

export type BatchSchemaSuggestionMerge = z.infer<
  typeof batchSchemaSuggestionMergeResponseSchema
>
