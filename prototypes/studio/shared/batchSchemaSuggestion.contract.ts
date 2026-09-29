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

export const batchSchemaSuggestionRunRequestSchema = z
  .object({ strategy: extractionStrategySchema })
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

const suggestionSourceSchema = z
  .object({
    sourceDocumentId: canonicalUuidSchema,
    sourceRepresentationRevisionId: canonicalUuidSchema,
    executionStatus: projectOperationStatusSchema,
    definition: schemaDefinitionSchema.nullable(),
    failure: operationFailureSchema.nullable(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
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
    executionStatus: projectOperationStatusSchema,
    phase: z.enum(['SOURCES', 'MERGING', 'READY', 'HETEROGENEOUS']),
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
    coverage: z.array(coverageSchema).nullable(),
    draft: schemaDefinitionSchema.nullable(),
    draftVersion: z.number().int().nonnegative(),
    failure: operationFailureSchema.nullable(),
    confirmedSchemaRevisionId: canonicalUuidSchema.nullable(),
    batchExtractionId: canonicalUuidSchema.nullable(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
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
