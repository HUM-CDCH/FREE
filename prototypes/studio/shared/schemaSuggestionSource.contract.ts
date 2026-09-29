import { z } from 'zod'
import { canonicalUuidSchema } from './projectContext.contract.js'

/** A range of a Source Document's canonical Markdown that Schema Suggestion did not send to the model: character
 *  offsets `[start, end)` into the whole source, and the physical page it lies on (null before the first page marker). */
export const sourceOmissionSchema = z
  .object({
    page: z.number().int().positive().nullable(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict()
  .refine((omission) => omission.start < omission.end)

/**
 * What one Schema Suggestion's model call received of its Source Document: all of it, or everything except the
 * declared ranges. A suggestion made from excerpts says so; it never claims whole-source coverage.
 */
export const sourceCoverageSchema = z.discriminatedUnion('complete', [
  z.object({ complete: z.literal(true) }).strict(),
  z
    .object({
      complete: z.literal(false),
      sourceCharacters: z.number().int().positive(),
      omitted: z.array(sourceOmissionSchema).min(1),
    })
    .strict(),
])

export type SourceOmission = z.infer<typeof sourceOmissionSchema>
export type SourceCoverage = z.infer<typeof sourceCoverageSchema>

/** A Batch Schema Suggestion's declaration: one entry per Source Document suggestion it combined. */
export const batchSourceCoverageSchema = z
  .array(z.object({ sourceDocumentId: canonicalUuidSchema, sourceCoverage: sourceCoverageSchema }).strict())
  .min(1)

export type BatchSourceCoverage = z.infer<typeof batchSourceCoverageSchema>
