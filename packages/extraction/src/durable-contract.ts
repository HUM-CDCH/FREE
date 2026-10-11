import { z } from 'zod'
import { schemaNodeSchema, schemaPathNames, isRecord } from './schema.js'
import { evidenceAnchorIdOf, evidenceSchema, groundedEvidenceSchema, unifiedEvidenceSchema } from './kei-evidence.js'

export const DURABLE_EXTRACTION_PROTOCOL = 1 as const
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
const disagreementRangeSchema = z.object({
  segment: z.string().min(1), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
}).strict()
export const valueDisagreementSchema = z.array(z.object({
  path: z.array(z.string()),
  alternatives: z.array(z.object({
    id: z.string().regex(/^[a-f0-9]{64}$/), value: z.unknown(),
    origins: z.array(z.object({
      selectionId: z.uuid(), generation: z.string().min(1),
      primary: z.array(disagreementRangeSchema), overlap: z.array(disagreementRangeSchema),
    }).strict()).min(1),
  }).strict()).min(2),
}).strict()).min(1)
export const durableValueSchema = z.object({
  id: z.string().min(1), recordId: z.string().min(1), fieldId: z.string().min(1),
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  selectionId: z.uuid(), schemaRevisionId: z.uuid(), node: schemaNodeSchema,
  modelValue: z.unknown(), evidence: z.array(z.object({
    anchorId: z.string().min(1), occurrenceIds: z.array(z.string()),
    producer: z.union([unifiedEvidenceSchema, groundedEvidenceSchema, evidenceSchema]),
  }).strict()),
  grounding: z.enum(['grounded', 'ungrounded', 'provisional']),
  processing: z.enum(['saved', 'absent', 'unprocessed', 'failed']),
  lineage: z.array(z.string()), disagreement: valueDisagreementSchema.optional(),
}).strict().superRefine((value,context)=> {
  value.disagreement?.forEach((entry,index)=> {
    const issue=(message:string)=>context.addIssue({code:'custom',path:['disagreement',index],message})
    if(value.processing!=='saved') issue('A Value Disagreement must be saved.')
    const names=schemaPathNames(value.node,entry.path)
    let at=value.modelValue
    for(const name of names??[]) at=isRecord(at)?at[name]:undefined
    if(!names || at!==null) issue('A disagreeing place must be null and addressed by object child IDs.')
    if(value.disagreement!.some((other,i)=>i!==index &&
      entry.path.length<=other.path.length && entry.path.every((id,j)=>id===other.path[j])))
      issue('Disagreeing paths must be distinct and cannot overlap.')
    if(new Set(entry.alternatives.map(alternative=>alternative.id)).size!==entry.alternatives.length)
      issue('Alternative IDs must be distinct.')
    if(entry.alternatives.some(alternative=>alternative.value===null || alternative.value===undefined))
      issue('Alternatives must be non-null.')
  })
  value.evidence.forEach((evidence,index)=> {
    if(evidence.anchorId!==evidenceAnchorIdOf(evidence.producer) ||
      !value.path.every((step,at)=>evidence.producer.path[at]===step))
      context.addIssue({code:'custom',path:['evidence',index],message:'Model Evidence must name this producing value and anchor.'})
  })
})
export type DurableValue = z.infer<typeof durableValueSchema>
export const durableCorrectionSchema = z.object({
  expectedRevision: z.number().int().nonnegative(), snapshotVersion: z.number().int().positive(),
  action: z.enum(['APPROVED', 'EDITED', 'REJECTED', 'PENDING']), value: z.unknown().optional(),
  evidence: z.array(z.object({ anchorId: z.string().min(1), occurrenceIds: z.array(z.string()).min(1) }).strict()).default([]),
  included: z.boolean().default(true),
  choices: z.array(z.object({ path: z.array(z.string()), value: z.unknown() }).strict()).min(1).optional(),
}).strict().superRefine((value,context)=> {
  if(value.choices && value.action!=='APPROVED')
    context.addIssue({code:'custom',path:['choices'],message:'Only an approval can choose readings.'})
})
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
