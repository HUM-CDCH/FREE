import { CANONICAL_UUID } from 'studio-configuration'
import { z } from 'zod'
import { extractionAttemptSchema } from './extraction.contract'
import { sourceCoverageSchema } from './schemaSuggestionSource.contract'
import {
  recordDescriptionSchema,
  recordScopeSchema,
  schemaNodesSchema,
} from 'extraction/schema'

export const canonicalUuidSchema = z
  .string()
  .regex(CANONICAL_UUID, 'Must be a canonical lowercase UUID.')

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
/** Where a Project Context currently sits in the five-phase workflow. */
export const projectContextWorkflowPhaseSchema = z.enum([
  'ingest',
  'chat',
  'approve',
  'extract',
  'validate',
])
const nonNegativeCount = z.number().int().nonnegative()
/**
 * Persisted per-project state computed server-side behind the store boundary,
 * so home cards never fan out per-project reads. The stale flag is
 * `staleSourceDocumentCount > 0`: a Source Document counts as stale exactly
 * when its Current Source Representation Revision differs from the one pinned
 * by its latest Extraction.
 */
export const projectContextActivitySummarySchema = z
  .object({
    phase: projectContextWorkflowPhaseSchema,
    extractionCount: nonNegativeCount,
    extractedSourceDocumentCount: nonNegativeCount,
    reviewedSourceDocumentCount: nonNegativeCount,
    staleSourceDocumentCount: nonNegativeCount,
    schemaDraftCount: nonNegativeCount,
    lastActivityAt: timestamp,
    runningBatch: z
      .object({
        completedMemberCount: nonNegativeCount,
        memberCount: nonNegativeCount,
      })
      .strict()
      .nullable(),
  })
  .strict()
export const projectContextListItemSchema = projectContextSummarySchema
  .extend({
    sourceDocumentCount: z.number().int().nonnegative(),
    summary: projectContextActivitySummarySchema,
  })
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
 * limit lives in `ResearcherProjectStore`; the module-load guard in
 * `api/project_contexts.ts` fails if the two ever disagree.
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
/**
 * One persisted event across the researcher's Project Contexts: an Extraction
 * appended, Review Decisions stored, a Schema Revision appended, or a Batch
 * Extraction opened.
 */
export const projectContextActivityEventSchema = z
  .object({
    kind: z.enum([
      'extraction_appended',
      'review_decisions_stored',
      'schema_revision_appended',
      'batch_extraction_opened',
    ]),
    projectContextId: canonicalUuidSchema,
    projectContextName: z.string(),
    occurredAt: timestamp,
  })
  .strict()
export const projectContextListResponseSchema = z
  .object({
    projectContexts: z.array(projectContextListItemSchema),
    // Defaulted so a reader of an older response shape still parses.
    recentActivity: z.array(projectContextActivityEventSchema).default([]),
  })
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
        /** The pinned revision's record scope; null for a legacy revision that declares none. */
        recordScope: recordScopeSchema.nullable(),
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
        /**
         * Whether this is the Source Document's current Source Representation
         * Revision. A reopen by `extractionId` opens that Extraction's own
         * revision, which reprocessing may have superseded.
         */
        current: z.boolean(),
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
        /** The current revision's record scope; null for a legacy revision that declares none. */
        recordScope: recordScopeSchema.nullable(),
        schemaNodes: schemaNodesSchema,
        /** What the Schema Suggestion behind this revision read of its source; null when not recorded. */
        sourceCoverage: sourceCoverageSchema.nullable(),
      })
      .strict()
      .nullable(),
    latestAttempt: reopenedExtractionSchema.nullable(),
    latestReviewed: reopenedExtractionSchema.nullable(),
    /** The newest Sample Extraction of this Source Representation, never latest above. */
    latestSample: reopenedExtractionSchema.nullable(),
  })
  .strict()
