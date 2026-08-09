import { z } from 'zod'
import { canonicalUuidSchema } from './projectContext.contract.js'
import { schemaNodesSchema } from './schemaNode.js'

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
        .omit({ schemaNodes: true })
        .extend({ summary: z.string().min(1) })
        .strict(),
    ),
  })
  .strict()

export const appendSchemaRevisionRequestSchema = z
  .object({
    projectContextId: canonicalUuidSchema,
    extractionSchemaId: canonicalUuidSchema,
    expectedRevisionNumber: z.number().int().nonnegative(),
    schemaNodes: schemaNodesSchema,
  })
  .strict()

export const initializeSchemaRevisionRequestSchema = z
  .object({
    projectContextId: canonicalUuidSchema,
    schemaNodes: schemaNodesSchema,
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
