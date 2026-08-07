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
export const projectContextWithDocumentsResponseSchema = z
  .object({
    projectContext: projectContextSummarySchema,
    sourceDocuments: z.array(sourceDocumentSummarySchema),
  })
  .strict()
export const projectContextErrorSchema = z
  .object({
    code: z.enum([
      'invalid_request',
      'not_found',
      'persistence_unavailable',
      'source_artifact_unavailable',
    ]),
    message: z.string(),
  })
  .strict()
export const projectContextErrorResponseSchema = z
  .object({ error: projectContextErrorSchema })
  .strict()

const revisionNumber = z.number().int().positive()

export const reviewDecisionSchema = z
  .object({
    reviewDecisionId: canonicalUuidSchema,
    evidenceAnchorId: z.string().min(1),
    reviewedOccurrenceIds: z.array(z.string().min(1)).min(1),
  })
  .strict()
/**
 * Annotations project only what Studio needs to reopen. Geometry, offsets, and
 * anchor internals stay in the parsed-document resource.
 */
export const annotationSchema = z
  .object({
    annotationId: canonicalUuidSchema,
    evidenceAnchorId: z.string(),
    text: z.string(),
    pageNumber: revisionNumber,
  })
  .strict()

/** Same-origin resources pinned to the exact reopened representation. */
export const sourceRepresentationResourcesSchema = z
  .object({
    sourcePdfUrl: z.string(),
    markdownUrl: z.string(),
    parsedDocumentUrl: z.string(),
  })
  .strict()

export const extractionSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      extractionId: canonicalUuidSchema,
      createdAt: timestamp,
      outcome: z.literal('succeeded'),
      result: z.json(),
      evidence: z.json().nullable(),
      reviewDecisions: z.array(reviewDecisionSchema),
    })
    .strict(),
  z
    .object({
      extractionId: canonicalUuidSchema,
      createdAt: timestamp,
      outcome: z.literal('failed'),
      failure: z.object({ code: z.string(), message: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      extractionId: canonicalUuidSchema,
      createdAt: timestamp,
      outcome: z.literal('cancelled'),
    })
    .strict(),
])

export const documentReopenResponseSchema = z
  .object({
    projectContext: projectContextSummarySchema,
    sourceDocument: sourceDocumentSummarySchema,
    sourceRepresentation: z
      .object({
        sourceRepresentationId: canonicalUuidSchema,
        revisionNumber,
        resources: sourceRepresentationResourcesSchema,
      })
      .strict(),
    annotationSet: z
      .object({
        annotationSetId: canonicalUuidSchema,
        revisionNumber,
        annotations: z.array(annotationSchema),
      })
      .strict()
      .nullable(),
    extractionSchema: z
      .object({
        extractionSchemaId: canonicalUuidSchema,
        revisionNumber,
        template: z.json(),
      })
      .strict()
      .nullable(),
    extraction: extractionSchema.nullable(),
  })
  .strict()
