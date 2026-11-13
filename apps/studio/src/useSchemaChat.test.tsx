// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SchemaRevision } from '../shared/schemaRevision.contract'
import type { SchemaEditResponse } from '../shared/schemaEdit.contract'
import { createSchemaEditorController, durableSchemaPersistence, type SchemaEditorController } from './currentSchemaRevision'
import { NO_ACTION_REPLY, useSchemaChat } from './useSchemaChat'

const { requestSchemaEdit, requestSchemaChat, deleteModelOperation, listModelOperations } = vi.hoisted(() => ({
  requestSchemaEdit: vi.fn(), requestSchemaChat: vi.fn(), deleteModelOperation: vi.fn(async () => {}), listModelOperations: vi.fn(async () => []),
}))
vi.mock('./api', async importOriginal => ({ ...await importOriginal<typeof import('./api')>(), requestSchemaEdit, requestSchemaChat, deleteModelOperation, listModelOperations }))
const initial: SchemaRevision = {
  extractionSchemaId: 'schema-1', schemaRevisionId: 'revision-1', revisionNumber: 1,
  origin: 'researcher-edit', createdAt: '2026-11-10T00:00:00.000Z', stabilisedAt: null,
  recordScope: 'document', recordDescription: 'One record.', schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
}
const proposal: SchemaEditResponse = { status: 'proposed', fields: { title: { name: 'heading', type: 'string', removed: false } }, additions: [], issues: [] }
const controllers: SchemaEditorController[] = []
function setup(sourceRepresentationId?: string) {
  const schema = createSchemaEditorController(durableSchemaPersistence({
    projectContextId: 'project-1', initial, debounceMs: 60_000,
    append: async (_schema, expected, definition) => ({ ...initial, ...definition, schemaRevisionId: `revision-${expected + 1}`, revisionNumber: expected + 1 }),
    initialize: async definition => ({ ...initial, ...definition }),
    listRevisions: async () => [], getRevision: async () => initial,
  }), { initialDraft: initial, initialExtractableRevisionId: initial.schemaRevisionId })
  controllers.push(schema)
  const hook = renderHook(() => useSchemaChat({ schema, sourceRepresentationId }))
  return { schema, hook }
}
afterEach(() => { cleanup(); for (const schema of controllers.splice(0)) schema.dispose(); vi.clearAllMocks() })

it.each(['field', 'description'] as const)('refuses a late model response after an accepted %s edit', async kind => {
  const response = Promise.withResolvers<SchemaEditResponse>()
  requestSchemaEdit.mockReturnValueOnce(response.promise)
  const { schema, hook } = setup()
  let sending!: Promise<void>
  await act(async () => { sending = hook.result.current.send('Rename title') })
  await waitFor(() => expect(requestSchemaEdit).toHaveBeenCalledOnce())
  act(() => {
    if (kind === 'field') schema.commit(nodes => nodes.map(node => ({ ...node, name: 'researcher_title' })), 'edit')
    else {
      const base = schema.snapshot().draft!
      schema.beginInput('description', 'Researcher description.', recordDescription => ({ ...base, recordDescription })).save()
    }
  })
  await act(async () => { response.resolve(proposal); await sending })
  expect(hook.result.current.proposalReview.pending).toBeNull()
  expect(hook.result.current.messages).toContainEqual({ role: 'assistant', text: 'Template changed while the request was running. Send the request again.' })
  if (kind === 'field') expect(schema.snapshot().draft?.schemaNodes[0].name).toBe('researcher_title')
  else expect(schema.snapshot().draft?.recordDescription).toBe('Researcher description.')
})

it('each model request has its own operation identity', async () => {
  requestSchemaEdit.mockResolvedValue({ status: 'refused', message: 'No change.' })
  const { hook } = setup()
  await act(() => hook.result.current.send('First request'))
  await act(() => hook.result.current.send('Second request'))
  const ids = requestSchemaEdit.mock.calls.map(call => call[3])
  expect(ids).toHaveLength(2)
  expect(new Set(ids).size).toBe(2)
  for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/)
})

it.each(['cancel', 'unmount'] as const)('aborts a model request on %s, with server cancellation only for an explicit Stop', async action => {
  let signal!: AbortSignal
  requestSchemaEdit.mockImplementationOnce((_context, _instruction, requestSignal: AbortSignal) => {
    signal = requestSignal
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
  })
  const { hook } = setup()
  let sending!: Promise<void>
  await act(async () => { sending = hook.result.current.send('Rename title') })
  await waitFor(() => expect(requestSchemaEdit).toHaveBeenCalledOnce())
  await act(async () => {
    if (action === 'cancel') hook.result.current.cancel()
    else hook.unmount()
    await sending
  })
  expect(signal.aborted).toBe(true)
  if (action === 'cancel') {
    expect(deleteModelOperation).toHaveBeenCalledWith(`edit:${requestSchemaEdit.mock.calls[0][3]}`)
    expect(hook.result.current.input).toBe('Rename title')
  } else expect(deleteModelOperation).not.toHaveBeenCalled()
})

it('answers a message that only declines with the chat box, proposing nothing', async () => {
  requestSchemaEdit.mockResolvedValueOnce({ status: 'declined' })
  const { hook } = setup()
  await act(() => hook.result.current.send('No thanks'))
  expect(hook.result.current.proposalReview.pending).toBeNull()
  expect(hook.result.current.messages.slice(-2)).toEqual([{ role: 'user', text: 'No thanks' }, { role: 'assistant', text: NO_ACTION_REPLY }])
})

it('before the first schema, a message that only declines is answered and never kept for generation', async () => {
  requestSchemaChat.mockResolvedValueOnce({ kind: 'none' })
  const { hook } = setup('representation-1')
  await act(() => hook.result.current.ask('not now'))
  expect(requestSchemaChat).toHaveBeenCalledOnce()
  expect(hook.result.current.instructions.items).toEqual([])
  expect(hook.result.current.messages.slice(-2)).toEqual([{ role: 'user', text: 'not now' }, { role: 'assistant', text: NO_ACTION_REPLY }])
})
