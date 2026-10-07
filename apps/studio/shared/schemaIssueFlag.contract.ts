import { z } from 'zod'
import { canonicalUuidSchema } from './projectContext.contract.js'

const timestamp = z.iso.datetime({ offset: true }).refine((value) => value.endsWith('Z'))

/**
 * A researcher-raised flag on one schema field within one Schema Revision
 * (guided-pilot-extraction-workflow, schema-issue-flagging). Flagging is
 * idempotent per `(schemaRevisionId, fieldPath)`.
 */
export const schemaIssueFlagSchema = z
  .object({
    schemaIssueFlagId: canonicalUuidSchema,
    schemaRevisionId: canonicalUuidSchema,
    fieldPath: z.string().min(1),
    note: z.string().nullable(),
    createdAt: timestamp,
  })
  .strict()

export const schemaIssueFlagRequestSchema = z
  .object({
    projectContextId: canonicalUuidSchema,
    schemaRevisionId: canonicalUuidSchema,
    fieldPath: z.string().min(1),
    note: z.string().optional(),
  })
  .strict()

export type SchemaIssueFlag = z.infer<typeof schemaIssueFlagSchema>
export type SchemaIssueFlagRequest = z.infer<typeof schemaIssueFlagRequestSchema>

export const schemaIssueFlagResponseSchema = z
  .object({ flag: schemaIssueFlagSchema })
  .strict()

export const schemaIssueFlagListResponseSchema = z
  .object({ flags: z.array(schemaIssueFlagSchema) })
  .strict()
