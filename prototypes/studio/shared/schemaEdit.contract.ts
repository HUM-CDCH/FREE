import { z } from 'zod'
import {
  isAllowedValues,
  NON_STRING_SCALAR_FIELD_TYPES,
  SCALAR_FIELD_TYPES,
} from 'extraction/allowed-values'

const NON_STRING_NON_ARRAY_FIELD_TYPES = [...NON_STRING_SCALAR_FIELD_TYPES, 'object'] as const

// Absent or null: leave the field's description as-is (models commonly emit null,
// not omission, for "nothing to set here"). "": clear it. Non-empty: set it — mirrors
// the editor's own description-button convention (descDraft.trim() || undefined).
const descriptionEditSchema = z.string().nullish()

// Absent or null: leave allowed values as-is. []: clear the constraint back to free
// text. 2+: pin the field to that closed set — same rule the editor's own form enforces.
const allowedValuesEditSchema = z
  .array(z.string().trim().min(1))
  .refine((values) => values.length === 0 || isAllowedValues(values), {
    message: 'Allowed values need at least 2 entries, or none to clear the constraint.',
  })
  .nullish()

const fieldEditBase = {
  name: z.string().trim().min(1),
  removed: z.boolean(),
  description: descriptionEditSchema,
}

export const fieldEditSchema = z.union([
  z.object({ ...fieldEditBase, type: z.literal('string'), allowedValues: allowedValuesEditSchema }).strict(),
  z.object({ ...fieldEditBase, type: z.enum(NON_STRING_NON_ARRAY_FIELD_TYPES) }).strict(),
  z.object({
    ...fieldEditBase,
    type: z.literal('array'),
    itemType: z.enum(SCALAR_FIELD_TYPES).nullable(),
  }).strict(),
])
export type FieldEdit = z.infer<typeof fieldEditSchema>

const additionBase = {
  path: z.array(z.string().trim().min(1)).min(1),
  description: descriptionEditSchema,
}

export const schemaAdditionSchema = z.union([
  z.object({ ...additionBase, type: z.literal('string'), allowedValues: allowedValuesEditSchema }).strict(),
  z.object({ ...additionBase, type: z.enum(NON_STRING_NON_ARRAY_FIELD_TYPES) }).strict(),
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
