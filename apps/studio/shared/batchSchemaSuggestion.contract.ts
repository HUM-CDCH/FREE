import { z } from 'zod'
import {
  BATCH_EXTRACTION_SELECTION_LIMIT,
  projectOperationStatusSchema,
} from './batchExtraction.contract.js'
import { canonicalUuidSchema } from './projectContext.contract.js'
import { schemaDefinitionSchema } from 'extraction/schema'
import { batchSourceCoverageSchema } from './schemaSuggestionSource.contract.js'

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

export const batchSchemaSuggestionCreateFromSpreadsheetRequestSchema = z
  .object({
    projectContextId: canonicalUuidSchema,
    /** Splits a column header into a nested path, e.g. "." groups
     *  `measurement.temperature` under a `measurement` object. Omit to
     *  keep every column flat. */
    separator: z.string().min(1).max(4).optional(),
  })
  .strict()

/** A retry names the attempt it follows, so a repeated POST replays its successor instead of starting another. */
export const batchSchemaSuggestionRetryRequestSchema = z
  .object({ expectedAttempt: z.number().int().positive() })
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

export const batchSchemaSuggestionSourceKindSchema = z.enum([
  'DOCUMENTS',
  'SPREADSHEET',
])

export type BatchSchemaSuggestionSourceKind = z.infer<
  typeof batchSchemaSuggestionSourceKindSchema
>

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
    phase: z.enum(['SOURCES', 'MERGING', 'READY', 'HETEROGENEOUS']).nullable(),
    /** A spreadsheet-derived suggestion has no document `sources` — it's
     *  ready immediately, skipping the SOURCES/MERGING phases (design.md
     *  D1b in the spreadsheet-schema-suggestion design). */
    sourceKind: batchSchemaSuggestionSourceKindSchema,
    /** Column name -> the matching `SchemaNode.id`, captured when a
     *  SPREADSHEET-kind suggestion was created; null for a DOCUMENTS-kind
     *  one. Lets a renamed field still be traced back to its source
     *  column after edits (design.md D3). */
    columnFieldMapping: z.record(z.string(), z.string()).nullable(),
    /** Which version of the project's shared spreadsheet this suggestion
     *  was built from; null for a DOCUMENTS-kind suggestion. */
    projectSpreadsheetVersionId: canonicalUuidSchema.nullable(),
    proposal: schemaDefinitionSchema.nullable(),
    /** What each Source Document suggestion read of its source; null before a proposal or when not recorded. */
    sourceCoverage: batchSourceCoverageSchema.nullable(),
    /** The current attempt's failure. */
    failure: operationFailureSchema.nullable(),
    /** The ordinary Extraction Schema the retained result was saved as (its revision 1); null until it is applied, or
     *  once that schema is deleted. From then on it is edited and run like any other template. */
    savedSchema: z
      .object({ extractionSchemaId: canonicalUuidSchema, schemaRevisionId: canonicalUuidSchema })
      .strict()
      .nullable(),
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
