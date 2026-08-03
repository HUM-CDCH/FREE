import { z } from 'zod'

export const canonicalUuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'Must be a canonical lowercase UUID.',
  )

const timestamp = z.iso
  .datetime({ offset: true })
  .refine((value) => value.endsWith('Z'))
export const projectContextSummarySchema = z
  .object({
    projectContextId: canonicalUuidSchema,
    name: z.string(),
    createdAt: timestamp,
  })
  .strict()
export const sourceDocumentSummarySchema = z
  .object({
    sourceDocumentId: canonicalUuidSchema,
    name: z.string(),
    createdAt: timestamp,
  })
  .strict()
export const projectContextListResponseSchema = z
  .object({ projectContexts: z.array(projectContextSummarySchema) })
  .strict()
export const projectContextChooserResponseSchema = z
  .object({
    projectContext: projectContextSummarySchema,
    sourceDocuments: z.array(sourceDocumentSummarySchema),
  })
  .strict()
export const projectContextErrorSchema = z
  .object({
    code: z.enum(['invalid_request', 'not_found', 'persistence_unavailable']),
    message: z.string(),
  })
  .strict()
export const projectContextErrorResponseSchema = z
  .object({ error: projectContextErrorSchema })
  .strict()
