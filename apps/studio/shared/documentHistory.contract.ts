import { z } from 'zod'
import { valueDisagreementSchema } from 'extraction/durable-contract'
import { schemaNodeSchema } from 'extraction/schema'
import { canonicalUuidSchema } from './projectContext.contract.js'

const schemaRevisionSchema = z.object({
  schemaRevisionId: canonicalUuidSchema,
  revisionNumber: z.number().int().positive(),
}).strict()

/** A Source Document's live Extractions, newest first, as the History tab lists them. `truncated` says older ones exist
 *  beyond the newest the list holds. */
export const documentHistoryResponseSchema = z.object({
  truncated: z.boolean(),
  extractions: z.array(z.object({
    extractionId: canonicalUuidSchema,
    createdAt: z.iso.datetime({ offset: true }),
    status: z.enum(['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING', 'STOPPED', 'FAILED', 'COMPLETED']),
    strategy: z.enum(['ARTICLE', 'CATALOG']),
    batchExtractionId: canonicalUuidSchema.nullable(),
    sourceRevisionNumber: z.number().int().positive(),
    /** Whether it read the document's current Source Representation. */
    currentSource: z.boolean(),
    /** The revisions its saved results and current inputs used. */
    schemaRevisions: z.array(schemaRevisionSchema),
    /** Inputs saved for later calls and not yet adopted. */
    pendingSchemaRevision: schemaRevisionSchema.nullable(),
    finalizations: z.array(z.object({
      snapshotVersion: z.number().int().positive(),
      feedbackVersion: z.number().int().nonnegative(),
      createdAt: z.iso.datetime({ offset: true }),
    }).strict()),
  }).strict()),
}).strict()

export type DocumentHistory = z.output<typeof documentHistoryResponseSchema>

const extractionStatusSchema = documentHistoryResponseSchema.shape.extractions.element.shape.status

/** One value's latest reading in each Extraction of the same History window that read its Source Representation, newest
 *  first, with the name and type it had there and the decision review shows. The others are counted: those on another
 *  Source Representation by revision, those without the value by Extraction. */
export const valueHistoryResponseSchema = z.object({
  truncated: z.boolean(),
  untraceableRevisions: z.number().int().nonnegative(),
  unmatched: z.number().int().nonnegative(),
  readings: z.array(z.object({
    extractionId: canonicalUuidSchema,
    createdAt: z.iso.datetime({ offset: true }),
    status: extractionStatusSchema,
    snapshotVersion: z.number().int().positive(),
    schemaRevision: schemaRevisionSchema,
    node: schemaNodeSchema,
    processing: z.enum(['saved', 'absent', 'unprocessed', 'failed']),
    modelValue: z.unknown(),
    disagreement: valueDisagreementSchema.nullable(),
    /** `value`, when present, is the value review shows: an edit, or the readings chosen at a Value Disagreement. */
    decision: z.object({ action: z.enum(['APPROVED', 'EDITED', 'REJECTED', 'PENDING']), value: z.unknown().optional() }).strict().nullable(),
    /** A saved decision that no longer fits the value's field. */
    decisionIncompatible: z.boolean(),
  }).strict()),
}).strict()

export type ValueHistory = z.output<typeof valueHistoryResponseSchema>
