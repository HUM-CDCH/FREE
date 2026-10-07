import { z } from 'zod'
import { canonicalUuidSchema } from './projectContext.contract.js'
import { sourceCoverageSchema } from './schemaSuggestionSource.contract.js'
import {
  recordDescriptionSchema,
  recordScopeSchema,
  schemaDefinitionSchema,
  schemaNodesSchema,
} from 'extraction/schema'

const timestamp = z.iso.datetime({ offset: true }).refine((value) => value.endsWith('Z'))

export const schemaRevisionOriginSchema = z.enum([
  'suggestion',
  'researcher-edit',
  'model-edit',
])

export const schemaRevisionSchema = z
  .object({
    schemaRevisionId: canonicalUuidSchema,
    extractionSchemaId: canonicalUuidSchema,
    revisionNumber: z.number().int().positive(),
    origin: schemaRevisionOriginSchema,
    createdAt: timestamp,
    /** Null while this revision is still in the piloting state; set once a
     *  researcher stabilises it (guided-workflow-phases). Reads as null when
     *  absent, so a revision read from a deployment that predates the column
     *  is simply unstabilised rather than unreadable. */
    stabilisedAt: timestamp.nullable().default(null),
    recordDescription: recordDescriptionSchema,
    /**
     * The definition's task scope, the one authority for Article (`document`: one document-level object) or Catalog
     * (`records`: a collection of records). Null is a legacy definition whose task selection was ambiguous: a choice
     * is required before it can run.
     */
    recordScope: recordScopeSchema.nullable(),
    schemaNodes: schemaNodesSchema,
  })
  .strict()

export const schemaRevisionResponseSchema = z
  .object({ revision: schemaRevisionSchema })
  .strict()

export const schemaRevisionListResponseSchema = z
  .object({
    revisions: z.array(
      schemaRevisionSchema
        .omit({ recordDescription: true, schemaNodes: true })
        .extend({ summary: z.string().min(1) })
        .strict(),
    ),
  })
  .strict()

export const extractionSchemaListResponseSchema = z
  .object({
    extractionSchemas: z.array(
      z
        .object({
          extractionSchemaId: canonicalUuidSchema,
          name: z.string().min(1),
          createdAt: timestamp,
          currentRevision: z
            .object({
              schemaRevisionId: canonicalUuidSchema,
              revisionNumber: z.number().int().positive(),
              origin: schemaRevisionOriginSchema,
              createdAt: timestamp,
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
  })
  .strict()

export const extractionSchemaNameLimit = 512
export const extractionSchemaNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(extractionSchemaNameLimit)
export const extractionSchemaWriteRequestSchema = z
  .object({
    projectContextId: canonicalUuidSchema,
    name: extractionSchemaNameSchema,
    /** The rename applies only while the schema still carries this name; omitted, it applies regardless. */
    expectedName: extractionSchemaNameSchema.optional(),
  })
  .strict()
export const extractionSchemaResponseSchema = z
  .object({
    extractionSchema: z
      .object({
        extractionSchemaId: canonicalUuidSchema,
        name: extractionSchemaNameSchema,
        createdAt: timestamp,
      })
      .strict(),
  })
  .strict()

/**
 * What a written revision declares of the Schema Suggestion behind its content. Absent from an append, the revision
 * inherits its head's declaration (an edit); null records none (content no suggestion produced).
 */
const writtenSourceCoverageSchema = sourceCoverageSchema.nullable().optional()

/**
 * The record scope a written revision declares. Absent from an append, the revision inherits its head's scope (an
 * edit never drops it); given, it is stored (a scope change is an explicit append). Absent from an initialization,
 * the revision declares none.
 */
const writtenRecordScopeSchema = recordScopeSchema.optional()

export const appendSchemaRevisionRequestSchema = z
  .object({
    projectContextId: canonicalUuidSchema,
    extractionSchemaId: canonicalUuidSchema,
    expectedRevisionNumber: z.number().int().nonnegative(),
    ...schemaDefinitionSchema.shape,
    recordScope: writtenRecordScopeSchema,
    sourceCoverage: writtenSourceCoverageSchema,
  })
  .strict()

export const initializeSchemaRevisionRequestSchema = z
  .object({
    projectContextId: canonicalUuidSchema,
    ...schemaDefinitionSchema.shape,
    recordScope: writtenRecordScopeSchema,
    sourceCoverage: writtenSourceCoverageSchema,
  })
  .strict()

export const schemaRevisionWriteRequestSchema = z.union([
  appendSchemaRevisionRequestSchema,
  initializeSchemaRevisionRequestSchema,
])

export type SchemaRevision = z.infer<typeof schemaRevisionSchema>
export type SchemaRevisionSummary = z.infer<
  typeof schemaRevisionListResponseSchema
>['revisions'][number]
export type ExtractionSchemaSummary = z.infer<
  typeof extractionSchemaListResponseSchema
>['extractionSchemas'][number]
