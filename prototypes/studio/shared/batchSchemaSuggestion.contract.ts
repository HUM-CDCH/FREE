import { z } from 'zod'
import { BATCH_EXTRACTION_SELECTION_LIMIT } from './batchExtraction.contract.js'
import { immediateUpstreamDetailSchema } from './modelConfig.contract.js'
import { canonicalUuidSchema } from './projectContext.contract.js'
import { schemaRevisionSchema } from './schemaRevision.contract.js'
import { schemaDefinitionSchema } from './schemaNode.js'

const sourceDocumentIdsSchema = z
  .array(canonicalUuidSchema)
  .min(1)
  .max(BATCH_EXTRACTION_SELECTION_LIMIT)
  .refine((ids) => new Set(ids).size === ids.length)

const selectionKeySchema = z.string().regex(/^[a-f0-9]{64}$/)

export const batchSchemaSuggestionRequestSchema = z.discriminatedUnion(
  'action',
  [
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
  ],
)

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

const sourceFailuresSchema = z
  .object({ sourceDocumentIds: sourceDocumentIdsSchema })
  .strict()
const sourceSuggestionFailureCodeSchema = z.enum([
  'invalid_model_config',
  'model_operation_failed',
  'invalid_model_output',
  'unexpected_failure',
])
const sourceSuggestionFailuresSchema = z
  .object({
    failures: z
      .array(
        z
          .object({
            sourceDocumentId: canonicalUuidSchema,
            code: sourceSuggestionFailureCodeSchema,
          })
          .strict(),
      )
      .min(1)
      .max(BATCH_EXTRACTION_SELECTION_LIMIT),
  })
  .strict()
const revisionConflictSchema = z
  .object({ currentRevision: schemaRevisionSchema })
  .strict()

export const batchSchemaSuggestionErrorSchema = z.union([
  z
    .object({
      code: z.enum([
        'invalid_request',
        'invalid_selection',
        'not_found',
        'persistence_unavailable',
        'unexpected_failure',
        'invalid_model_output',
        'invalid_model_config',
        'selection_changed',
      ]),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal('model_operation_failed'),
      message: z.string(),
      details: z
        .object({ upstream: immediateUpstreamDetailSchema })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      code: z.literal('suggestions_pending'),
      message: z.string(),
      details: sourceFailuresSchema,
    })
    .strict(),
  z
    .object({
      code: z.literal('source_suggestion_failed'),
      message: z.string(),
      details: sourceSuggestionFailuresSchema,
    })
    .strict(),
  z
    .object({
      code: z.literal('revision_conflict'),
      message: z.string(),
      details: revisionConflictSchema,
    })
    .strict(),
])

export const batchSchemaSuggestionErrorResponseSchema = z
  .object({ error: batchSchemaSuggestionErrorSchema })
  .strict()

export type BatchSchemaSuggestionMerge = z.infer<
  typeof batchSchemaSuggestionMergeResponseSchema
>
export type BatchSchemaSuggestionFailure = z.infer<
  typeof batchSchemaSuggestionErrorSchema
>
