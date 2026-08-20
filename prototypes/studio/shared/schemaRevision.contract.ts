import { z } from 'zod'
import { canonicalUuidSchema } from './projectContext.contract.js'
import {
  recordDescriptionSchema,
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
    recordDescription: recordDescriptionSchema,
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

export const appendSchemaRevisionRequestSchema = z
  .object({
    projectContextId: canonicalUuidSchema,
    extractionSchemaId: canonicalUuidSchema,
    expectedRevisionNumber: z.number().int().nonnegative(),
    ...schemaDefinitionSchema.shape,
  })
  .strict()

export const initializeSchemaRevisionRequestSchema = z
  .object({
    projectContextId: canonicalUuidSchema,
    ...schemaDefinitionSchema.shape,
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
