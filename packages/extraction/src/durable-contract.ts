import { z } from 'zod'
import { schemaNodeSchema } from './schema.js'

export const DURABLE_EXTRACTION_PROTOCOL = 1 as const
// Exposure is deliberately OFF. Completing a release matrix is an operator
// action; loading new readers or starting DBOS cannot enable admissions.
export const DURABLE_RELEASE_VERIFIED = false
export const durableAdmissionsEnabled = () => DURABLE_RELEASE_VERIFIED && process.env.FREE_DURABLE_EXTRACTION_ADMISSIONS === '1'
export const durableCommandSchema = z.object({
  id: z.uuid(), expectedVersion: z.number().int().nonnegative(),
  action: z.enum(['pause', 'resume', 'stop', 'retry', 'editing', 'discard']),
}).strict()
export const durableSelectionSchema = z.object({
  expectedVersion: z.number().int().nonnegative(), schemaRevisionId: z.uuid(), method: z.unknown(),
}).strict()
export const durableAdoptSchema = z.object({
  expectedVersion: z.number().int().nonnegative(), selectionId: z.uuid(),
  reprocessValueIds: z.array(z.string().min(1)).max(10000).default([]),
}).strict()
export const durableValueSchema = z.object({
  id: z.string().min(1), recordId: z.string().min(1), fieldId: z.string().min(1),
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  selectionId: z.uuid(), schemaRevisionId: z.uuid(), node: schemaNodeSchema,
  modelValue: z.unknown(), evidence: z.array(z.object({
    anchorId: z.string().min(1), occurrenceIds: z.array(z.string()),
  }).strict()),
  grounding: z.enum(['grounded', 'ungrounded', 'provisional']),
  processing: z.enum(['saved', 'absent', 'unprocessed', 'failed']),
  lineage: z.array(z.string()),
}).strict()
export type DurableValue = z.infer<typeof durableValueSchema>
export const durableCorrectionSchema = z.object({
  expectedRevision: z.number().int().nonnegative(), snapshotVersion: z.number().int().positive(),
  action: z.enum(['APPROVED', 'EDITED', 'REJECTED', 'PENDING']), value: z.unknown().optional(),
  evidence: z.array(z.object({ anchorId: z.string().min(1), occurrenceIds: z.array(z.string()).min(1) }).strict()).default([]),
  included: z.boolean().default(true),
}).strict()
export const durableStatusSchema = z.enum(['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING', 'STOPPED', 'FAILED', 'COMPLETED'])
export type DurableStatus = z.infer<typeof durableStatusSchema>
export const durableHeadSchema = z.object({
  id: z.uuid(), projectId: z.uuid(), sourceRevisionId: z.uuid(), sourcePin: z.record(z.string(), z.unknown()),
  strategy: z.enum(['ARTICLE', 'CATALOG']), selectionId: z.uuid(), pendingSelectionId: z.uuid().nullable(),
  intent: z.enum(['RUN', 'PAUSE', 'STOP']), controlVersion: z.number().int(), pendingResume: z.boolean(),
  acknowledgement: z.enum(['QUEUED', 'RUNNING', 'PAUSED', 'STOPPED', 'FAILED', 'COMPLETED']),
  attemptId: z.uuid().nullable(), fence: z.number().int(), leaseEpoch: z.number().int(),
  leaseOwner: z.uuid().nullable(), leaseUntil: z.coerce.date().nullable(),
  generation: z.number().int(), snapshotVersion: z.number().int(), deleted: z.boolean(),
}).strict()
export type DurableHead = z.infer<typeof durableHeadSchema>
export function durableStatus(head: DurableHead): DurableStatus {
  if (head.intent === 'STOP') return head.acknowledgement === 'STOPPED' ? 'STOPPED' : 'STOPPING'
  if (head.acknowledgement === 'COMPLETED' || head.acknowledgement === 'FAILED') return head.acknowledgement
  if (head.intent === 'PAUSE') return head.acknowledgement === 'PAUSED' ? 'PAUSED' : 'PAUSING'
  return head.acknowledgement
}
