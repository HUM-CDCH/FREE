import { z } from 'zod'
import { extractionAttemptSchema } from './extraction.contract'
import {
  recordDescriptionSchema,
  schemaNodesSchema,
} from 'extraction/schema'

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
export const projectContextListItemSchema = projectContextSummarySchema
  .extend({ sourceDocumentCount: z.number().int().nonnegative() })
  .strict()
export const sourceDocumentSummarySchema = z
  .object({
    sourceDocumentId: canonicalUuidSchema,
    name: z.string(),
    createdAt: timestamp,
  })
  .strict()
const projectContextSourceDocumentSchema = sourceDocumentSummarySchema
  .extend({ pageCount: z.number().int().positive().nullable() })
  .strict()
/**
 * One name contract for creating and renaming a Project Context. The durable
 * limit lives in `ResearcherProjectStore`;
 * `api/project_contexts.test.ts` fails if the two ever disagree.
 */
export const projectContextNameLimit = 512
export const projectContextNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(projectContextNameLimit)
export const projectContextWriteRequestSchema = z
  .object({ name: projectContextNameSchema })
  .strict()
export const projectContextResponseSchema = z
  .object({ projectContext: projectContextSummarySchema })
  .strict()
export const projectContextListResponseSchema = z
  .object({ projectContexts: z.array(projectContextListItemSchema) })
  .strict()
export const projectContextWithDocumentsResponseSchema = z
  .object({
    projectContext: projectContextSummarySchema,
    sourceDocuments: z.array(projectContextSourceDocumentSchema),
  })
  .strict()
export const projectContextErrorSchema = z
  .object({
    code: z.enum([
      'invalid_request',
      'not_found',
      'persistence_unavailable',
      'source_artifact_unavailable',
      'source_ingestion_failed',
      'source_ingestion_timeout',
    ]),
    message: z.string(),
  })
  .strict()
export const projectContextErrorResponseSchema = z
  .object({ error: projectContextErrorSchema })
  .strict()

const revisionNumber = z.number().int().positive()

/**
 * Annotations project only what Studio needs to reopen. Geometry, offsets, and
 * anchor internals stay in the source resource.
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

export const reopenedExtractionSchema = extractionAttemptSchema
  .extend({
    sourceRepresentation: z
      .object({
        revisionNumber,
        resources: sourceRepresentationResourcesSchema,
      })
      .strict(),
    extractionSchema: z
      .object({
        extractionSchemaId: canonicalUuidSchema,
        revisionNumber,
        recordDescription: recordDescriptionSchema,
        schemaNodes: schemaNodesSchema,
      })
      .strict(),
  })
  .strict()

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
        name: z.string().min(1),
        schemaRevisionId: canonicalUuidSchema,
        revisionNumber,
        recordDescription: recordDescriptionSchema,
        schemaNodes: schemaNodesSchema,
      })
      .strict()
      .nullable(),
    latestAttempt: reopenedExtractionSchema.nullable(),
    latestReviewed: reopenedExtractionSchema.nullable(),
  })
  .strict()
