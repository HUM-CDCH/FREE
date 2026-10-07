import { z } from 'zod'
import { canonicalUuidSchema } from './projectContext.contract.js'

const timestamp = z.iso.datetime({ offset: true }).refine((value) => value.endsWith('Z'))

/** One developer evaluation round, as the read-only surface shows it. `pins`
 *  and `metrics` keep the pipeline's own JSON shape; the reader renders the
 *  fields it knows and leaves the rest opaque. */
export const evaluationRoundSchema = z
  .object({
    evaluationRoundId: canonicalUuidSchema,
    projectSpreadsheetVersionId: canonicalUuidSchema.nullable(),
    pipelineRunId: canonicalUuidSchema,
    label: z.enum(['PILOT_1', 'PILOT_2', 'BATCH']),
    status: z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED']),
    documents: z.unknown(),
    pins: z.unknown().nullable(),
    metrics: z.unknown().nullable(),
    failure: z.unknown().nullable(),
    createdAt: timestamp,
    completedAt: timestamp.nullable(),
  })
  .strict()

export const evaluationRoundsResponseSchema = z
  .object({ evaluationRounds: z.array(evaluationRoundSchema) })
  .strict()

export type EvaluationRound = z.output<typeof evaluationRoundSchema>
export type EvaluationRoundsResponse = z.output<typeof evaluationRoundsResponseSchema>
