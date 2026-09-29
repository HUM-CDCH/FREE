import { describe, expect, it } from 'vitest'
import { MODEL_OPERATION_WORKFLOW_ID, modelOperationListingSchema, modelOperationSchema } from './modelOperation.contract'

const UUID = '51000000-0000-4000-8009-0000000000f1'

describe('MODEL_OPERATION_WORKFLOW_ID', () => {
  it('matches a generation or edit workflow ID and captures its kind and operation ID', () => {
    expect(MODEL_OPERATION_WORKFLOW_ID.exec(`suggestion:${UUID}`)?.slice(1)).toEqual(['suggestion', UUID])
    expect(MODEL_OPERATION_WORKFLOW_ID.exec(`edit:${UUID}`)?.slice(1)).toEqual(['edit', UUID])
  })

  it('refuses other kinds, trailing text, upper-case IDs and suffixes', () => {
    for (const id of [`chat:${UUID}`, `suggestion:${UUID}\n`, `edit:${UUID.toUpperCase()}`, `suggestion:${UUID}:x`, UUID, ''])
      expect(MODEL_OPERATION_WORKFLOW_ID.test(id), id).toBe(false)
  })
})

describe('modelOperationSchema', () => {
  const common = {
    workflowId: `suggestion:${UUID}`, operationId: UUID, status: 'SUCCEEDED', instruction: 'Catalog entries',
    createdAt: '2026-09-26T10:00:00.000Z', failure: null,
  }

  it('accepts a generation and a proposal, and a listing of at most 20', () => {
    const generation = { kind: 'generation', ...common, baseSchemaRevisionId: null, template: { title: 'string' }, sourceCoverage: { complete: true } }
    const proposal = {
      kind: 'proposal', ...common, workflowId: `edit:${UUID}`, status: 'FAILED', failure: { code: 'interrupted', message: 'Stopped.' },
      baseSchemaRevisionId: UUID, response: null,
    }
    expect(modelOperationSchema.parse(generation)).toEqual(generation)
    expect(modelOperationSchema.parse(proposal)).toEqual(proposal)
    expect(modelOperationListingSchema.safeParse({ operations: [generation, proposal] }).success).toBe(true)
    expect(modelOperationListingSchema.safeParse({ operations: Array.from({ length: 21 }, () => generation) }).success).toBe(false)
  })

  it('refuses a proposal without a base, an unknown status and an extra key', () => {
    expect(modelOperationSchema.safeParse({ kind: 'proposal', ...common, baseSchemaRevisionId: null, response: null }).success).toBe(false)
    expect(modelOperationSchema.safeParse({ kind: 'generation', ...common, status: 'DONE', baseSchemaRevisionId: null, template: null, sourceCoverage: null }).success).toBe(false)
    expect(modelOperationSchema.safeParse({ kind: 'generation', ...common, baseSchemaRevisionId: null, template: null, sourceCoverage: null, extra: 1 }).success).toBe(false)
  })
})
