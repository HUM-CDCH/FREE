import type { WorkflowStatus } from '@dbos-inc/dbos-sdk'
import { executionOf, INTERRUPTED_FAILURE } from 'db'
import { z } from 'zod'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import { INGEST_SOURCE, type IngestionInput } from './_ingestion_workflow.js'

export type IngestionAttempt = { status: WorkflowStatus; input: IngestionInput }
export type ClassifiedOutcome =
  | { kind: 'live'; status: 'queued' | 'parsing' }
  | { kind: 'succeeded'; sourceDocumentId: string }
  | { kind: 'failed'; failure: { code: string; message: string } }

const inputSchema = z.object({ originalName: z.string(), sourceSha256: z.string() }).loose()
const outcomeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), sourceDocument: z.object({ sourceDocumentId: canonicalUuidSchema }).loose() }).loose(),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }).loose(),
])

/** This project's `ingestSource` attempt with a readable input, or null. */
export function attemptOf(status: WorkflowStatus, projectContextId: string): IngestionAttempt | null {
  if (status.workflowName !== INGEST_SOURCE || status.attributes?.projectContextId !== projectContextId) return null
  const input = inputSchema.safeParse(status.input?.[0])
  return input.success ? { status, input: input.data as unknown as IngestionInput } : null
}

/** One reading of an attempt's DBOS record, shared by the listing and dismissal. */
export function classifyOutcome(status: WorkflowStatus): ClassifiedOutcome {
  const execution = executionOf(status.status)
  if (execution === 'QUEUED') return { kind: 'live', status: 'queued' }
  if (execution === 'RUNNING') return { kind: 'live', status: 'parsing' }
  const output = status.status === 'SUCCESS' ? outcomeSchema.safeParse(status.output) : null
  if (output?.success && output.data.ok) return { kind: 'succeeded', sourceDocumentId: output.data.sourceDocument.sourceDocumentId }
  if (output?.success && !output.data.ok)
    return { kind: 'failed', failure: { code: output.data.code.slice(0, 128), message: output.data.message.slice(0, 512) } }
  return { kind: 'failed', failure: { ...INTERRUPTED_FAILURE } }
}

/** M6's rule for when history may be deleted: settled, or stopped and last updated before this process booted. */
export function isQuiescent(status: WorkflowStatus, bootTimestampMs: number): boolean {
  if (status.status === 'SUCCESS' || status.status === 'ERROR') return true
  if (status.status === 'CANCELLED' || status.status === 'MAX_RECOVERY_ATTEMPTS_EXCEEDED')
    return status.updatedAt !== undefined && status.updatedAt < bootTimestampMs
  return false
}
