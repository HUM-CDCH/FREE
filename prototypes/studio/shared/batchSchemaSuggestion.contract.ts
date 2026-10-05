import { z } from 'zod'
import { extractionMethodIntentSchema } from 'extraction/extraction-method'
import {
  BATCH_EXTRACTION_SELECTION_LIMIT,
  batchMethodFitsStrategy,
  projectOperationStatusSchema,
} from './batchExtraction.contract.js'
import { extractionStrategySchema, methodRuleIssues } from './extraction.contract.js'
import { validationDetailsSchema } from './modelConfig.contract.js'
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

export const batchSchemaSuggestionPurposeSchema = z.enum([
  'SCHEMA',
  'SCHEMA_AND_VALIDATE',
])

export type BatchSchemaSuggestionPurpose = z.infer<
  typeof batchSchemaSuggestionPurposeSchema
>

export const batchSchemaSuggestionCreateFromSpreadsheetRequestSchema = z
  .object({
    projectContextId: canonicalUuidSchema,
    /** Splits a column header into a nested path, e.g. "." groups
     *  `measurement.temperature` under a `measurement` object. Omit to
     *  keep every column flat. */
    separator: z.string().min(1).max(4).optional(),
    /** `true` infers each field's type (number/integer/enum/string) from
     *  its column's cell values; `false` reads only the header row and
     *  gives every field a plain `string` type. */
    inferTypesFromValues: z.boolean(),
    /** `SCHEMA` seeds the schema and stops there; `SCHEMA_AND_VALIDATE`
     *  also populates an Evaluation Corpus version from this project's
     *  current spreadsheet once the suggestion is confirmed — reading the
     *  "filename" column (case-insensitive) to resolve each row against a
     *  Source Document, and every other column via the confirmed
     *  column-to-field mapping. Not inferred from whether cells are
     *  filled in (extraction-quality-evaluation design.md D1b). */
    purpose: batchSchemaSuggestionPurposeSchema,
  })
  .strict()

export const batchSchemaSuggestionDraftRequestSchema = z
  .object({
    expectedDraftVersion: z.number().int().nonnegative(),
    ...schemaDefinitionSchema.shape,
  })
  .strict()

/** Run carries the saved method the start view showed, as a Batch Extraction request does. */
export const batchSchemaSuggestionRunRequestSchema = z
  .object({ strategy: extractionStrategySchema, method: extractionMethodIntentSchema })
  .strict()
  .refine(batchMethodFitsStrategy, {
    path: ['method', 'settings'],
    message: 'The saved settings do not match this Extraction Strategy.',
  })
  .superRefine(methodRuleIssues)

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
     *  D1b in openspec/changes/spreadsheet-schema-suggestion). */
    sourceKind: batchSchemaSuggestionSourceKindSchema,
    /** Only set for a SPREADSHEET-kind suggestion; null for DOCUMENTS. */
    purpose: batchSchemaSuggestionPurposeSchema.nullable(),
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
      'method_changed',
      'record_scope_required',
      'record_scope_mismatch',
      'invalid_identity_fields',
      'incompatible_extraction_model',
      'invalid_model_config',
    ]),
    message: z.string(),
    /** A refused request's field-addressed issues (`boundedValidationDetails`), e.g. a Run's rule-breaking method. */
    details: validationDetailsSchema.optional(),
  })
  .strict()

export const batchSchemaSuggestionErrorResponseSchema = z
  .object({ error: batchSchemaSuggestionErrorSchema })
  .strict()

export type BatchSchemaSuggestionFailure = z.infer<
  typeof batchSchemaSuggestionErrorSchema
>
