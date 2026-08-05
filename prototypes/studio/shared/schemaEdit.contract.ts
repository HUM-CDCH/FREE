import { z } from 'zod'
import { FIELD_TYPES } from './allowedValues.js'

export const fieldEditSchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(FIELD_TYPES),
  removed: z.boolean(),
}).strict()
export type FieldEdit = z.infer<typeof fieldEditSchema>

export const schemaAdditionSchema = z.object({
  path: z.array(z.string().trim().min(1)).min(1),
  type: z.enum(FIELD_TYPES),
}).strict()
export type SchemaAddition = z.infer<typeof schemaAdditionSchema>

export const schemaEditIssueSchema = z.object({
  kind: z.enum(['missing', 'invalid', 'unknown-key']),
  key: z.string(),
}).strict()
export type SchemaEditIssue = z.infer<typeof schemaEditIssueSchema>

export const proposedSchemaEditSchema = z.object({
  status: z.literal('proposed'),
  fields: z.record(z.string(), fieldEditSchema),
  additions: z.array(schemaAdditionSchema),
  issues: z.array(schemaEditIssueSchema),
}).strict()
export type ProposedSchemaEdit = z.infer<typeof proposedSchemaEditSchema>

export const schemaEditResponseSchema = z.discriminatedUnion('status', [
  proposedSchemaEditSchema,
  z.object({ status: z.literal('refused'), message: z.string() }).strict(),
  z.object({ status: z.literal('failed'), message: z.string() }).strict(),
])
export type SchemaEditResponse = z.infer<typeof schemaEditResponseSchema>
