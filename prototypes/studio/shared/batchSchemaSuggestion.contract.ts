import { z } from 'zod'
import {
  BATCH_EXTRACTION_SELECTION_LIMIT,
  projectOperationStatusSchema,
} from './batchExtraction.contract.js'
import { extractionStrategySchema } from './extraction.contract.js'
import { canonicalUuidSchema } from './projectContext.contract.js'
import { schemaDefinitionSchema } from 'extraction/schema'

const sourceDocumentIdsSchema = z
  .array(canonicalUuidSchema)
  .min(1)
  .max(BATCH_EXTRACTION_SELECTION_LIMIT)
  .refine((ids) => new Set(ids).size === ids.length)

const selectionKeySchema = z.string().regex(/^[a-f0-9]{64}$/)

export const batchSchemaSuggestionCreateRequestSchema = z
  .object({
    projectContextId: canonicalUuidSchema,
    sourceDocumentIds: sourceDocumentIdsSchema,
  })
  .strict()

export const batchSchemaSuggestionDraftRequestSchema = z
  .object({
    expectedDraftVersion: z.number().int().nonnegative(),
    ...schemaDefinitionSchema.shape,
  })
  .strict()

export const batchSchemaSuggestionRunRequestSchema = z
  .object({ strategy: extractionStrategySchema })
  .strict()

/** A retry names the attempt it follows, so a repeated POST replays its successor instead of starting another. */
export const batchSchemaSuggestionRetryRequestSchema = z
  .object({ expectedAttempt: z.number().int().positive() })
  .strict()

const coverageSchema = z
  .object({
    nodeId: z.string().min(1),
    present: z.number().int().nonnegative(),
    total: z.number().int().positive(),
  })
  .strict()

const operationFailureSchema = z
  .object({ code: z.string().min(1), message: z.string().min(1) })
  .strict()

/** A member pin only: per-source progress, definitions and errors are not part of the contract. */
const suggestionSourceSchema = z
  .object({
    sourceDocumentId: canonicalUuidSchema,
    sourceRepresentationRevisionId: canonicalUuidSchema,
  })
  .strict()

export const batchSchemaSuggestionSchema = z
  .object({
    batchSchemaSuggestionId: canonicalUuidSchema,
    projectContextId: canonicalUuidSchema,
    selectionKey: selectionKeySchema,
    /** The current attempt; a retry names it as `expectedAttempt`. */
    attempt: z.number().int().positive(),
    /** Derived from the current attempt: its outcome, else its workflow's status. */
    executionStatus: projectOperationStatusSchema,
    /** The retained proposal's meaning; null before the first proposal. */
    phase: z.enum(['READY', 'HETEROGENEOUS']).nullable(),
    proposal: schemaDefinitionSchema.nullable(),
    coverage: z.array(coverageSchema).nullable(),
    draft: schemaDefinitionSchema.nullable(),
    draftVersion: z.number().int().nonnegative(),
    /** The current attempt's failure. */
    failure: operationFailureSchema.nullable(),
    confirmedSchemaRevisionId: canonicalUuidSchema.nullable(),
    batchExtractionId: canonicalUuidSchema.nullable(),
    createdAt: z.iso.datetime(),
    sources: z.array(suggestionSourceSchema),
  })
  .strict()

export type BatchSchemaSuggestion = z.output<typeof batchSchemaSuggestionSchema>

export const batchSchemaSuggestionResponseSchema = z
  .object({ batchSchemaSuggestion: batchSchemaSuggestionSchema })
  .strict()

export const batchSchemaSuggestionListResponseSchema = z
  .object({ batchSchemaSuggestions: z.array(batchSchemaSuggestionSchema) })
  .strict()

export const batchSchemaSuggestionErrorSchema = z
  .object({
    code: z.enum([
      'invalid_request',
      'invalid_selection',
      'not_found',
      'persistence_unavailable',
      'unexpected_failure',
      'draft_conflict',
      'operation_not_ready',
      'attempt_conflict',
    ]),
    message: z.string(),
  })
  .strict()

export const batchSchemaSuggestionErrorResponseSchema = z
  .object({ error: batchSchemaSuggestionErrorSchema })
  .strict()

export type BatchSchemaSuggestionFailure = z.infer<
  typeof batchSchemaSuggestionErrorSchema
>
