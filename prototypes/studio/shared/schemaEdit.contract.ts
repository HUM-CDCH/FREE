import { z } from 'zod'
import { SCALAR_FIELD_TYPES } from 'extraction/allowed-values'

const NON_ARRAY_FIELD_TYPES = [...SCALAR_FIELD_TYPES, 'object'] as const

const fieldEditBase = {
  name: z.string().trim().min(1),
  removed: z.boolean(),
}

export const fieldEditSchema = z.union([
  z.object({ ...fieldEditBase, type: z.enum(NON_ARRAY_FIELD_TYPES) }).strict(),
  z.object({
    ...fieldEditBase,
    type: z.literal('array'),
    itemType: z.enum(SCALAR_FIELD_TYPES).nullable(),
  }).strict(),
])
export type FieldEdit = z.infer<typeof fieldEditSchema>

const additionBase = { path: z.array(z.string().trim().min(1)).min(1) }

export const schemaAdditionSchema = z.union([
  z.object({ ...additionBase, type: z.enum(NON_ARRAY_FIELD_TYPES) }).strict(),
  z.object({
    ...additionBase,
    type: z.literal('array'),
    itemType: z.enum(SCALAR_FIELD_TYPES).nullable(),
  }).strict(),
])
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
