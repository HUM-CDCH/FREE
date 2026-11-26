import { z } from 'zod'

/** One change the chat proposes to a saved value (ADR 0035): an edit to `value`, or a rejection. Nothing is saved until
 *  the researcher applies it, as a correction of that value through Results' own save, with `expectedRevision`. */
export const proposedCorrectionSchema = z.object({
  valueId: z.string().min(1),
  /** Where the value is, as Results names it: its record (or the document) and field. */
  label: z.string(),
  action: z.enum(['EDITED', 'REJECTED']),
  /** The value as it stands now, the researcher's decision applied. */
  current: z.unknown(),
  value: z.unknown().optional(),
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().nullable(),
}).strict()
export type ProposedCorrection = z.infer<typeof proposedCorrectionSchema>

/** The chat's proposal for one result snapshot: the changes, what the model said to the researcher, and each change it
 *  proposed that was left out (a value it does not have, or a value that does not fit its field). */
export const resultCorrectionProposalSchema = z.object({
  extractionId: z.string().min(1),
  snapshotVersion: z.number().int().positive(),
  corrections: z.array(proposedCorrectionSchema),
  reply: z.string().nullable(),
  dropped: z.array(z.string()),
  /** What the message asks that the current template cannot hold, as one instruction for a template change (ADR
   *  0037): the chat proposes that change, and a run with it. Absent from proposals made before it. */
  templateChange: z.string().nullable().optional(),
  /** Why running the extraction again, with the template as it is, may meet what the values cannot (ADR 0042): records
   *  or entries the results missed, or a value the chat could not find in the source. Never beside a template change. */
  rerun: z.string().nullable().optional(),
}).strict()
export type ResultCorrectionProposal = z.infer<typeof resultCorrectionProposalSchema>
