// @vitest-environment jsdom
import { testSchemaPersistence } from './test/schemaPersistence'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SchemaNode } from 'extraction/schema'
import { deriveSchemaProposal } from '../shared/schemaChanges'
import { createSchemaEditorController } from './currentSchemaRevision'
import { useSchemaProposalReview } from './useSchemaProposalReview'

const { deleteModelOperation } = vi.hoisted(() => ({
  deleteModelOperation: vi.fn<(workflowId: string) => Promise<void>>(async () => undefined),
}))
vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  deleteModelOperation,
}))

const original: SchemaNode[] = [{ id: 'title', name: 'title', type: 'string' }]
const rename = deriveSchemaProposal(original, {
  status: 'proposed', fields: { title: { name: 'heading', type: 'string', removed: false } }, additions: [], issues: [],
})
const WORKFLOW = 'edit:51000000-0000-4000-8009-0000000000f1'

function setup() {
  const schema = createSchemaEditorController(testSchemaPersistence(), {
    initialDraft: { recordDescription: 'One record.', schemaNodes: original },
  })
  const messages: string[] = []
  const hook = renderHook(() => useSchemaProposalReview(schema, (message) => messages.push(message)))
  return { schema, messages, hook }
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('useSchemaProposalReview and the proposal workflow', () => {
  it("Discard deletes the proposal's workflow on the server; Apply does not", async () => {
    const { schema, messages, hook } = setup()

    act(() => hook.result.current.start(rename, original, schema.snapshot().draftVersion, null, WORKFLOW))
    act(() => hook.result.current.discard())

    expect(deleteModelOperation).toHaveBeenCalledExactlyOnceWith(WORKFLOW)
    expect(messages).toEqual(['Okay — discarded, no changes made.'])
    expect(hook.result.current.pending).toBeNull()

    deleteModelOperation.mockRejectedValueOnce(new Error('503'))
    act(() => hook.result.current.start(rename, original, schema.snapshot().draftVersion, null, WORKFLOW))
    act(() => hook.result.current.discard())
    await waitFor(() => expect(messages).toHaveLength(3))
    expect(messages[2]).toBe('The proposal could not be discarded on the server; it may return after a reload.')

    deleteModelOperation.mockClear()
    act(() => hook.result.current.start(rename, original, schema.snapshot().draftVersion, null, WORKFLOW))
    act(() => hook.result.current.apply())
    expect(schema.snapshot().draft?.schemaNodes.map((node) => node.name)).toEqual(['heading'])
    expect(deleteModelOperation).not.toHaveBeenCalled()

    // A proposal without a workflow (none recorded) discards locally only.
    act(() => hook.result.current.start(rename, schema.snapshot().draft!.schemaNodes, schema.snapshot().draftVersion, null, null))
    act(() => hook.result.current.discard())
    expect(deleteModelOperation).not.toHaveBeenCalled()
  })
})


it('an old reset cannot release the proposal that replaced it', () => {
  const { schema, hook } = setup()
  act(() => hook.result.current.start(rename, original, schema.snapshot().draftVersion, null, null))
  const oldReset = hook.result.current.reset
  act(() => hook.result.current.start(rename, original, schema.snapshot().draftVersion, null, null))
  act(() => oldReset())
  expect(hook.result.current.pending).not.toBeNull()
  expect(schema.snapshot().useBlockedReason).toContain('pending proposal')
  act(() => hook.result.current.discard())
  expect(schema.snapshot().useBlockedReason).toBeNull()
})

it('uses the same controller predicate to disable Apply and refuse it during History, then discards stale authority', async () => {
  const historical = Promise.withResolvers<import('../shared/schemaRevision.contract').SchemaRevision>()
  const revision = {
    extractionSchemaId: 'schema-1', schemaRevisionId: 'revision-1', revisionNumber: 1,
    origin: 'researcher-edit' as const, createdAt: '2026-11-10T00:00:00.000Z', stabilisedAt: null,
    recordScope: 'document' as const, recordDescription: 'One record.', schemaNodes: original,
  }
  const schema = createSchemaEditorController(testSchemaPersistence({ getRevision: () => historical.promise, flush: async () => revision }), { initialDraft: revision })
  const messages: string[] = []
  const hook = renderHook(() => useSchemaProposalReview(schema, message => messages.push(message)))
  let creating!: ReturnType<typeof schema.createCurrentRevisionFromHistory>
  act(() => { creating = schema.createCurrentRevisionFromHistory('historical') })
  act(() => hook.result.current.start(rename, original, schema.snapshot().draftVersion, null, null))
  expect(hook.result.current.canApply).toBe(false)
  act(() => expect(hook.result.current.apply()).toBe(false))
  expect(messages).toEqual(['A historical revision is being applied.'])
  expect(hook.result.current.pending).not.toBeNull()
  await act(async () => { historical.resolve(revision); await creating })
  expect(hook.result.current.canApply).toBe(false)
  act(() => expect(hook.result.current.apply()).toBe(false))
  expect(messages.at(-1)).toBe('Template changed during review. The proposal was discarded.')
  expect(hook.result.current.pending).toBeNull()
  expect(schema.snapshot().draft?.schemaNodes).toEqual(original)
  schema.dispose()
})
