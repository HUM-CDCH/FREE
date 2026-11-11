// @vitest-environment jsdom
import { testSchemaPersistence } from './test/schemaPersistence'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SchemaModelContext } from './api'
import type { ChatHistory } from '../shared/schemaChat.contract'
import type { ProjectChatEntry } from '../shared/projectChat.contract'
import { createSchemaEditorController } from './currentSchemaRevision'
import { boundedHistory, useProjectChatLog } from './projectChat'
import { useSchemaChat, type ChatScope } from './useSchemaChat'

const { authenticatedFetch, requestSchemaEdit } = vi.hoisted(() => ({ authenticatedFetch: vi.fn(), requestSchemaEdit: vi.fn() }))
vi.mock('./auth/authenticatedFetch', () => ({ authenticatedFetch, requestModelKeyResend: vi.fn() }))
vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  requestSchemaEdit,
  listModelOperations: vi.fn(async () => []),
  deleteModelOperation: vi.fn(async () => undefined),
}))

const projectContextId = '51000000-0000-4000-8000-000000000001'
const documentA = '51000000-0000-4000-8001-00000000000a'
const documentB = '51000000-0000-4000-8001-00000000000b'
const id = (n: number) => `51000000-0000-4000-8013-${n.toString().padStart(12, '0')}`

/** A stored chat, and the bodies of the writes made to it, in order. */
function server(stored: { projectChatEntryId: string; entry: ProjectChatEntry }[] = [], failures = 0, clearFailures = 0) {
  const appended: ProjectChatEntry[][] = []
  const deleted: string[] = []
  /** Each clear, as the number of writes made before it. */
  const cleared: number[] = []
  authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (!init?.method)
      return Response.json({ entries: stored.map((item, index) => ({ ...item, position: index + 1, createdAt: '2026-11-03T10:00:00.000Z' })) })
    if (init.method === 'DELETE') {
      if (url.endsWith('/chat')) {
        if (clearFailures-- > 0) return new Response(null, { status: 503 })
        cleared.push(appended.length)
        return new Response(null, { status: 204 })
      }
      deleted.push(url.split('/').at(-1)!)
      return new Response(null, { status: 204 })
    }
    if (failures-- > 0) return new Response(null, { status: 503 })
    appended.push((JSON.parse(String(init.body)) as { entries: { entry: ProjectChatEntry }[] }).entries.map(({ entry }) => entry))
    return Response.json({ entries: [] }, { status: 201 })
  })
  return { appended, deleted, cleared, kept: () => appended.flat() }
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('boundedHistory', () => {
  const message = (text: string, role: ChatHistory[number]['role'] = 'user') => ({ role, text })

  it('keeps a conversation that fits whole', () => {
    const history = [message('a'), message('b', 'assistant')]
    expect(boundedHistory(history, 10)).toBe(history)
  })

  it('keeps the latest messages, says the rest is left out, and names the document they were about', () => {
    const history = [message('about A', 'note'), message('x'.repeat(8)), message('about B', 'note'), message('y'.repeat(8)), message('z'.repeat(8))]
    expect(boundedHistory(history, 16)).toEqual([
      { role: 'note', text: 'Earlier messages are left out.' }, message('about B', 'note'), message('y'.repeat(8)), message('z'.repeat(8)),
    ])
  })

  it('keeps at most the message limit', () => {
    const history = Array.from({ length: 5 }, (_, index) => message(`m${index}`))
    expect(boundedHistory(history, 1_000, 2)).toEqual([{ role: 'note', text: 'Earlier messages are left out.' }, message('m3'), message('m4')])
  })
})

describe('useProjectChatLog', () => {
  it('writes in order, and a failed write goes again with the next', async () => {
    const { appended } = server([], 1)
    const { result } = renderHook(() => useProjectChatLog(projectContextId))
    await waitFor(() => expect(result.current.loaded).toEqual([]))
    act(() => result.current.keep([{ id: id(1), entry: { kind: 'message', role: 'user', text: 'first' } }]))
    await waitFor(() => expect(result.current.unsaved).toBe(true))
    act(() => result.current.keep([{ id: id(2), entry: { kind: 'message', role: 'user', text: 'second' } }]))
    await waitFor(() => expect(result.current.unsaved).toBe(false))
    expect(appended).toEqual([[{ kind: 'message', role: 'user', text: 'first' }, { kind: 'message', role: 'user', text: 'second' }]])
  })

  it('removes an entry not yet written without a request, and a written one after its write', async () => {
    const { deleted, kept } = server()
    const { result } = renderHook(() => useProjectChatLog(projectContextId))
    await waitFor(() => expect(result.current.loaded).toEqual([]))
    act(() => {
      result.current.keep([{ id: id(1), entry: { kind: 'instruction', text: 'kept' } }, { id: id(2), entry: { kind: 'instruction', text: 'taken back' } }])
      result.current.remove(id(2))
    })
    await waitFor(() => expect(kept()).toEqual([{ kind: 'instruction', text: 'kept' }]))
    act(() => result.current.remove(id(1)))
    await waitFor(() => expect(deleted).toEqual([id(1)]))
  })

  it('clears after the write on its way, never sending what was queued; a failed clear keeps the queue', async () => {
    const { appended, cleared } = server([], 1, 1)
    const { result } = renderHook(() => useProjectChatLog(projectContextId))
    await waitFor(() => expect(result.current.loaded).toEqual([]))
    act(() => result.current.keep([{ id: id(1), entry: { kind: 'message', role: 'user', text: 'unsent' } }]))
    await waitFor(() => expect(result.current.unsaved).toBe(true))
    // The clear fails: the unsent entry is still queued, and goes with the next write.
    await act(() => expect(result.current.clear()).rejects.toThrow('could not be cleared'))
    expect(cleared).toEqual([])
    // It clears now: the queued entry is dropped, never sent.
    await act(() => result.current.clear())
    expect(cleared).toEqual([0])
    expect(result.current.unsaved).toBe(false)
    act(() => result.current.keep([{ id: id(2), entry: { kind: 'message', role: 'user', text: 'after' } }]))
    await waitFor(() => expect(appended).toEqual([[{ kind: 'message', role: 'user', text: 'after' }]]))
  })

  it('keeps nothing without a project', () => {
    const { result } = renderHook(() => useProjectChatLog(null))
    act(() => result.current.keep([{ id: id(1), entry: { kind: 'message', role: 'user', text: 'lost' } }]))
    expect(result.current.loaded).toBeNull()
    expect(authenticatedFetch).not.toHaveBeenCalled()
  })
})

describe('useSchemaChat kept with its project', () => {
  const stored = [
    { projectChatEntryId: id(1), entry: { kind: 'instruction', text: 'Focus on dates' } },
    { projectChatEntryId: id(2), entry: { kind: 'document', sourceDocumentId: documentA, name: 'a.pdf' } },
    { projectChatEntryId: id(3), entry: { kind: 'message', role: 'user', text: 'Add a sender' } },
    { projectChatEntryId: id(4), entry: { kind: 'message', role: 'assistant', text: 'Added.' } },
    { projectChatEntryId: id(5), entry: { kind: 'step', title: 'Run extraction', choice: '▶ Run extraction' } },
  ] satisfies { projectChatEntryId: string; entry: ProjectChatEntry }[]

  function renderChat(scope: ChatScope) {
    const schema = createSchemaEditorController(testSchemaPersistence(), {
      initialDraft: { recordDescription: 'One letter.', schemaNodes: [{ id: 'sender', name: 'sender', type: 'string' }] },
    })
    // The local draft has no revision: the model context names none, so the answer is taken as current.
    vi.spyOn(schema, 'requestModelEdit').mockResolvedValue({ projectContextId, extractionSchemaId: id(9), schemaRevisionId: null } as unknown as SchemaModelContext)
    return renderHook(() => useSchemaChat({ schema, scope }))
  }

  it('reopens with what was said, and says a turn to another document before what is said on it', async () => {
    const { kept } = server(stored)
    requestSchemaEdit.mockResolvedValueOnce({ status: 'answered', answer: 'It has 3 senders.' })
    const { result } = renderChat({ projectContextId, sourceDocumentId: documentB, name: 'b.pdf' })
    await waitFor(() => expect(result.current.messages).toHaveLength(4))
    expect(result.current.instructions.items).toEqual([{ id: id(1), text: 'Focus on dates' }])

    await act(() => result.current.send('How many senders?'))

    expect(result.current.messages.slice(4)).toEqual([
      { role: 'document', sourceDocumentId: documentB, name: 'b.pdf' },
      { role: 'user', text: 'How many senders?' },
      { role: 'assistant', text: 'It has 3 senders.' },
    ])
    await waitFor(() => expect(kept()).toEqual([
      { kind: 'document', sourceDocumentId: documentB, name: 'b.pdf' },
      { kind: 'message', role: 'user', text: 'How many senders?' },
      { kind: 'message', role: 'assistant', text: 'It has 3 senders.' },
    ]))
    // The model reads which document each part was about, the current one last; a step is a click, not said.
    expect(requestSchemaEdit.mock.calls[0]![4]).toEqual([
      { role: 'user', text: 'Focus on dates' },
      { role: 'assistant', text: 'Recorded as an instruction for template generation.' },
      { role: 'note', text: 'The researcher turned to the Source Document “a.pdf”.' },
      { role: 'user', text: 'Add a sender' },
      { role: 'assistant', text: 'Added.' },
      { role: 'note', text: 'The researcher turned to the Source Document “b.pdf”.' },
    ])
  })

  it('keeps no message taken back with Stop', async () => {
    const { kept } = server(stored)
    requestSchemaEdit.mockImplementationOnce((_context, _message, signal: AbortSignal) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })))
    const { result } = renderChat({ projectContextId, sourceDocumentId: documentA, name: 'a.pdf' })
    await waitFor(() => expect(result.current.messages).toHaveLength(4))
    let sending!: Promise<void>
    act(() => { sending = result.current.send('Never mind') })
    await waitFor(() => expect(requestSchemaEdit).toHaveBeenCalledOnce())
    act(() => result.current.cancel())
    await act(() => sending)
    expect(result.current.input).toBe('Never mind')
    // Still on a.pdf, as the stored chat last said: no turn, and nothing kept.
    expect(kept()).toEqual([])
  })

  it('clears the conversation where it is kept, then names the document again before what is said next', async () => {
    const { cleared, kept } = server(stored)
    requestSchemaEdit.mockResolvedValueOnce({ status: 'answered', answer: 'Three.' })
    const { result } = renderChat({ projectContextId, sourceDocumentId: documentA, name: 'a.pdf' })
    await waitFor(() => expect(result.current.messages).toHaveLength(4))
    await act(() => result.current.clearConversation())
    expect(cleared).toEqual([0])
    expect(result.current.messages).toEqual([])
    expect(result.current.instructions.items).toEqual([])

    await act(() => result.current.send('How many senders?'))
    await waitFor(() => expect(kept()).toEqual([
      { kind: 'document', sourceDocumentId: documentA, name: 'a.pdf' },
      { kind: 'message', role: 'user', text: 'How many senders?' },
      { kind: 'message', role: 'assistant', text: 'Three.' },
    ]))
    // Nothing from before the clear reaches the model.
    expect(requestSchemaEdit.mock.calls[0]![4]).toEqual([{ role: 'note', text: 'The researcher turned to the Source Document “a.pdf”.' }])
  })

  it('keeps the conversation shown when the clear fails', async () => {
    server(stored, 0, 1)
    const { result } = renderChat({ projectContextId, sourceDocumentId: documentA, name: 'a.pdf' })
    await waitFor(() => expect(result.current.messages).toHaveLength(4))
    await act(() => expect(result.current.clearConversation()).rejects.toThrow('could not be cleared'))
    expect(result.current.messages).toHaveLength(4)
    expect(result.current.instructions.items).toHaveLength(1)
  })

  it('forgets an instruction taken back', async () => {
    const { deleted } = server(stored)
    const { result } = renderChat({ projectContextId, sourceDocumentId: documentA, name: 'a.pdf' })
    await waitFor(() => expect(result.current.instructions.items).toHaveLength(1))
    act(() => result.current.instructions.remove(id(1)))
    await waitFor(() => expect(deleted).toEqual([id(1)]))
  })
})
