import { z } from 'zod'
import { canonicalUuidSchema } from './projectContext.contract.js'

const timestamp = z.iso.datetime({ offset: true }).refine((value) => value.endsWith('Z'))

export const spreadsheetColumnSchema = z
  .object({
    columnName: z.string().min(1),
    values: z.array(z.unknown()),
  })
  .strict()

/** One version of a Project Context's single shared spreadsheet slot —
 *  uploading again appends a new version rather than replacing this one
 *  (mirrors SchemaRevision). */
export const projectSpreadsheetVersionSchema = z
  .object({
    projectSpreadsheetVersionId: canonicalUuidSchema,
    projectContextId: canonicalUuidSchema,
    revisionNumber: z.number().int().positive(),
    originalFilename: z.string().min(1),
    columns: z.array(spreadsheetColumnSchema),
    createdAt: timestamp,
  })
  .strict()

export type ProjectSpreadsheetVersion = z.output<
  typeof projectSpreadsheetVersionSchema
>

export const projectSpreadsheetVersionResponseSchema = z
  .object({
    /** Null when the project has no uploaded spreadsheet yet — not an error. */
    projectSpreadsheetVersion: projectSpreadsheetVersionSchema.nullable(),
  })
  .strict()

export const projectSpreadsheetErrorSchema = z
  .object({
    code: z.enum([
      'invalid_request',
      'not_found',
      'persistence_unavailable',
      'unexpected_failure',
    ]),
    message: z.string(),
  })
  .strict()

export const projectSpreadsheetErrorResponseSchema = z
  .object({ error: projectSpreadsheetErrorSchema })
  .strict()

export type ProjectSpreadsheetFailure = z.infer<
  typeof projectSpreadsheetErrorSchema
>
