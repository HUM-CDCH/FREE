import { describe, expect, it } from 'vitest'
import type { ModelOperation } from '../shared/modelOperation.contract'
import type { SchemaEditorSnapshot } from './currentSchemaRevision'
import { planRecovery, recoveryView, type RecoveryView } from './modelOperationRecovery'

const R1 = '51000000-0000-4000-8004-000000000001'
const R2 = '51000000-0000-4000-8004-000000000002'
const uuid = (n: number) => `51000000-0000-4000-8009-0000000000${n.toString(16).padStart(2, '0')}`
type Generation = Extract<ModelOperation, { kind: 'generation' }>
type Proposal = Extract<ModelOperation, { kind: 'proposal' }>
const PROPOSED: Proposal['response'] = { status: 'proposed', fields: {}, additions: [], issues: [] }
const TEMPLATE = { _description: 'One entry.', title: 'string' }

/** Operations are newest first, as the listing returns them: a lower `n` is newer. */
function generation(n: number, status: ModelOperation['status'], over: Partial<Generation> = {}): Generation {
  return {
    kind: 'generation', workflowId: `suggestion:${uuid(n)}`, operationId: uuid(n), status, instruction: `Instruction ${n}`,
    createdAt: new Date(1_700_000_000_000 - n).toISOString(), failure: null, baseSchemaRevisionId: R1,
    template: status === 'SUCCEEDED' ? TEMPLATE : null, sourceCoverage: null, ...over,
  }
}
function proposal(n: number, status: ModelOperation['status'], over: Partial<Proposal> = {}): Proposal {
  return {
    kind: 'proposal', workflowId: `edit:${uuid(n)}`, operationId: uuid(n), status, instruction: `Instruction ${n}`,
    createdAt: new Date(1_700_000_000_000 - n).toISOString(), failure: null, baseSchemaRevisionId: R1,
    response: status === 'SUCCEEDED' ? PROPOSED : null, ...over,
  }
}
const view = (over: Partial<RecoveryView> = {}): RecoveryView => ({ cleanCurrentRevisionId: R1, noSchemaYet: false, busy: false, ...over })
const nothing = { saveGeneration: null, reopenProposal: null }

describe('planRecovery', () => {
  it('a running operation is shown and nothing else acts', () => {
    const running = [generation(1, 'RUNNING'), proposal(2, 'QUEUED')]
    expect(planRecovery(running, view())).toEqual({ running, ...nothing, keyMissing: [] })
  })

  it('the newest finished generation whose base is the clean current revision is saved', () => {
    const newest = generation(1, 'SUCCEEDED')
    const plan = planRecovery([newest, generation(2, 'SUCCEEDED')], view())
    expect(plan).toEqual({ running: [], saveGeneration: newest, reopenProposal: null, keyMissing: [] })
  })

  it('a generation whose base is older, or a draft that is dirty or was recovered from the session, is dropped', () => {
    expect(planRecovery([generation(1, 'SUCCEEDED', { baseSchemaRevisionId: R2 })], view())).toMatchObject(nothing)
    expect(planRecovery([generation(1, 'SUCCEEDED')], view({ cleanCurrentRevisionId: null }))).toMatchObject(nothing)
    expect(planRecovery([generation(1, 'SUCCEEDED')], view({ cleanCurrentRevisionId: R2 }))).toMatchObject(nothing)
  })

  it('a first generation is saved only while no Extraction Schema exists', () => {
    const first = generation(1, 'SUCCEEDED', { baseSchemaRevisionId: null })
    expect(planRecovery([first], view({ cleanCurrentRevisionId: null, noSchemaYet: true })).saveGeneration).toBe(first)
    expect(planRecovery([first], view({ cleanCurrentRevisionId: null, noSchemaYet: false })).saveGeneration).toBeNull()
    expect(planRecovery([first], view()).saveGeneration).toBeNull()
  })

  it('the newest finished proposal on the clean current revision is reopened, unless a review or a request is under way', () => {
    const newest = proposal(1, 'SUCCEEDED')
    expect(planRecovery([newest, proposal(2, 'SUCCEEDED')], view())).toEqual({ running: [], saveGeneration: null, reopenProposal: newest, keyMissing: [] })
    const busy = planRecovery([generation(0, 'RUNNING'), newest], view({ busy: true }))
    expect(busy).toEqual({ running: [generation(0, 'RUNNING')], ...nothing, keyMissing: [] })
  })

  it('of a generation and a proposal on the same base, only the newer acts', () => {
    const newerProposal = planRecovery([proposal(1, 'SUCCEEDED'), generation(2, 'SUCCEEDED')], view())
    expect(newerProposal).toMatchObject({ saveGeneration: null, reopenProposal: proposal(1, 'SUCCEEDED') })
    const newerGeneration = planRecovery([generation(1, 'SUCCEEDED'), proposal(2, 'SUCCEEDED')], view())
    expect(newerGeneration).toMatchObject({ saveGeneration: generation(1, 'SUCCEEDED'), reopenProposal: null })
  })

  it('a failed or refused proposal, and a finished operation on another base, acts on nothing', () => {
    const operations = [
      proposal(1, 'FAILED', { failure: { code: 'interrupted', message: 'Stopped.' } }),
      proposal(2, 'SUCCEEDED', { response: { status: 'refused', message: 'No.' } }),
      proposal(3, 'SUCCEEDED', { baseSchemaRevisionId: R2 }),
      generation(4, 'SUCCEEDED', { baseSchemaRevisionId: R2 }),
      generation(5, 'FAILED', { failure: { code: 'model_operation_failed', message: 'Failed.' } }),
    ]
    expect(planRecovery(operations, view())).toEqual({ running: [], ...nothing, keyMissing: [] })
  })

  it('model_key_required failures are named once for a key resend', () => {
    const missing = { code: 'model_key_required', message: 'Send the key.' }
    const plan = planRecovery([
      generation(1, 'FAILED', { failure: missing }),
      proposal(2, 'FAILED', { failure: missing }),
      proposal(3, 'FAILED', { failure: { code: 'interrupted', message: 'Stopped.' } }),
    ], view())
    expect(plan.keyMissing).toEqual([`suggestion:${uuid(1)}`, `edit:${uuid(2)}`])
  })
})

describe('recoveryView', () => {
  const acknowledged = { schemaRevisionId: R1, extractionSchemaId: 'schema-1', revisionNumber: 1, recordDescription: 'One entry.', recordScope: null, stabilisedAt: null, schemaNodes: [] }
  const snapshot = (over: Partial<SchemaEditorSnapshot> = {}): SchemaEditorSnapshot => ({
    view: 'editing', generating: false, generationError: null, cancellationError: null, draft: { recordDescription: 'One entry.', schemaNodes: [] },
    draftVersion: 0, replacementVersion: 0, save: { status: 'saved', acknowledged, draft: { recordDescription: 'One entry.', schemaNodes: [] }, recordScope: null },
    history: [], extractionSchemaId: 'schema-1', currentRevisionNumber: 1, extractableSchemaRevisionId: R1,
    creatingFromRevisionId: null, previewingRevisionId: null, historicalPreview: null, sourceCoverage: null, recordScope: null, ...over,
  })

  it('names the clean current revision only when saved and the draft is exactly the acknowledged one', () => {
    expect(recoveryView(snapshot(), false)).toEqual({ cleanCurrentRevisionId: R1, noSchemaYet: false, busy: false })
    expect(recoveryView(snapshot({ extractableSchemaRevisionId: null }), false).cleanCurrentRevisionId).toBeNull()
    expect(recoveryView(snapshot({ save: { status: 'dirty', acknowledged, draft: { recordDescription: 'x', schemaNodes: [] }, recordScope: null } }), false).cleanCurrentRevisionId).toBeNull()
    expect(recoveryView(snapshot({ save: null }), false).cleanCurrentRevisionId).toBeNull()
  })

  it('is busy while a review or request runs, a generation runs, or a historical revision is previewed', () => {
    expect(recoveryView(snapshot(), true).busy).toBe(true)
    expect(recoveryView(snapshot({ generating: true }), false).busy).toBe(true)
    expect(recoveryView(snapshot({ historicalPreview: { ...acknowledged, origin: 'suggestion', createdAt: 'now' } }), false).busy).toBe(true)
  })

  it('has no schema yet only with neither a durable schema nor a draft', () => {
    expect(recoveryView(snapshot({ view: 'empty', draft: null, save: null, extractionSchemaId: null, extractableSchemaRevisionId: null }), false))
      .toEqual({ cleanCurrentRevisionId: null, noSchemaYet: true, busy: false })
    expect(recoveryView(snapshot({ save: null, extractionSchemaId: null, extractableSchemaRevisionId: null }), false).noSchemaYet).toBe(false)
  })
})
