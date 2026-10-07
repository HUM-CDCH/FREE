import type { ModelOperation } from '../shared/modelOperation.contract'
import type { SchemaEditorSnapshot } from './currentSchemaRevision'

export type RecoveryView = Readonly<{
  /** The acknowledged revision when the draft is clean on it; null while dirty, unsaved, recovered or local. */
  cleanCurrentRevisionId: string | null
  noSchemaYet: boolean
  busy: boolean
}>
export type RecoveryPlan = Readonly<{
  running: readonly ModelOperation[]
  saveGeneration: Extract<ModelOperation, { kind: 'generation' }> | null
  reopenProposal: Extract<ModelOperation, { kind: 'proposal' }> | null
  /** Workflow IDs that failed with model_key_required: the page resends its keys once for them. */
  keyMissing: readonly string[]
}>

export function recoveryView(snapshot: SchemaEditorSnapshot, busy: boolean): RecoveryView {
  const save = snapshot.save
  // Clean: saved, and the visible draft is exactly the acknowledged revision.
  const clean = save?.status === 'saved' && snapshot.extractableSchemaRevisionId === save.acknowledged.schemaRevisionId
  return {
    cleanCurrentRevisionId: clean ? save.acknowledged.schemaRevisionId : null,
    noSchemaYet: snapshot.extractionSchemaId === null && snapshot.draft === null,
    busy: busy || snapshot.generating || snapshot.historicalPreview !== null,
  }
}

const live = (operation: ModelOperation) => operation.status === 'QUEUED' || operation.status === 'RUNNING'

/**
 * What a page does with the operations it found on load (spec, *What the schema panel does on load*). Running ones are
 * shown and polled. Of the finished ones, only the newest whose base is still the current revision acts — a generation
 * is saved, a proposal reopened, never both, since saving moves the base — and only while nothing else is under way. A
 * generation without a base acts only while no Extraction Schema exists; a proposal only onto a clean draft. Everything
 * else is dropped, as a reload drops a conflicted save today.
 */
export function planRecovery(operations: readonly ModelOperation[], view: RecoveryView): RecoveryPlan {
  const onBase = (operation: ModelOperation) =>
    operation.baseSchemaRevisionId === null ? view.noSchemaYet : operation.baseSchemaRevisionId === view.cleanCurrentRevisionId
  const actionable = (operation: ModelOperation) =>
    operation.status === 'SUCCEEDED' && onBase(operation)
    && (operation.kind === 'generation' ? operation.template !== null : operation.response?.status === 'proposed')
  const newest = view.busy ? undefined : operations.find(actionable)
  return {
    running: operations.filter(live),
    saveGeneration: newest?.kind === 'generation' ? newest : null,
    reopenProposal: newest?.kind === 'proposal' ? newest : null,
    keyMissing: operations.filter((operation) => operation.failure?.code === 'model_key_required').map((operation) => operation.workflowId),
  }
}
