// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SchemaNode } from 'extraction/schema'
import { deriveSchemaProposal } from '../shared/schemaChanges'
import { createSchemaEditorController, localSchemaPersistence } from './currentSchemaRevision'
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
  const schema = createSchemaEditorController(localSchemaPersistence({ onEdit: () => {} }), {
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
