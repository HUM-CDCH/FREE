import { describe, expect, it, vi } from 'vitest'
import type { ProjectChatEntryRecord, ResearcherProjectStore } from 'db'
import { createResearcherApiHandlers } from './project_chat.js'

const projectContextId = '51000000-0000-4000-8000-000000000001'
const entryId = '51000000-0000-4000-8013-000000000001'
const now = new Date('2026-11-03T10:00:00.000Z')
const url = (suffix = '') => `http://test/api/project-contexts/${projectContextId}/chat${suffix}`
const record = (overrides: Partial<ProjectChatEntryRecord> = {}): ProjectChatEntryRecord =>
  ({ projectChatEntryId: entryId, position: 1, entry: { kind: 'message', role: 'user', text: 'Add a recipient' }, createdAt: now, ...overrides })

function handlers(store: Partial<ResearcherProjectStore>) {
  return createResearcherApiHandlers(store as ResearcherProjectStore)
}

describe('project chat API', () => {
  it('reads the latest entries, leaving out one this Studio no longer reads', async () => {
    const listProjectChatEntries = vi.fn().mockResolvedValue([record(), record({ position: 2, entry: { kind: 'retired' } })])
    const response = await handlers({ listProjectChatEntries }).GET!(new Request(url()))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ entries: [{ projectChatEntryId: entryId, position: 1, entry: record().entry, createdAt: now.toISOString() }] })
    expect(listProjectChatEntries).toHaveBeenCalledWith(projectContextId, 1000)
  })

  it('appends entries in order and says what it added', async () => {
    const appendProjectChatEntries = vi.fn().mockResolvedValue([record()])
    const entries = [{ projectChatEntryId: entryId, entry: record().entry }]
    const response = await handlers({ appendProjectChatEntries }).POST!(new Request(url(), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entries }),
    }))
    expect(response.status).toBe(201)
    expect(appendProjectChatEntries).toHaveBeenCalledWith(projectContextId, entries)
  })

  it('refuses an entry of no known kind, or too long, before the store', async () => {
    const appendProjectChatEntries = vi.fn()
    const post = (entry: unknown) => handlers({ appendProjectChatEntries }).POST!(new Request(url(), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entries: [{ projectChatEntryId: entryId, entry }] }),
    }))
    expect((await post({ kind: 'note', text: 'x' })).status).toBe(422)
    expect((await post({ kind: 'message', role: 'user', text: 'x'.repeat(20_001) })).status).toBe(422)
    expect(appendProjectChatEntries).not.toHaveBeenCalled()
  })

  it('removes one entry, and says not found for another account\'s project or a missing entry', async () => {
    const deleteProjectChatEntry = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(null)
    const remove = () => handlers({ deleteProjectChatEntry }).DELETE!(new Request(url(`/${entryId}`), { method: 'DELETE' }))
    expect((await remove()).status).toBe(204)
    expect((await remove()).status).toBe(404)
    expect((await remove()).status).toBe(404)
    expect(deleteProjectChatEntry).toHaveBeenCalledWith(projectContextId, entryId)
  })

  it('needs canonical IDs, and an entry only for DELETE', async () => {
    const store = { listProjectChatEntries: vi.fn().mockResolvedValue(null) }
    expect((await handlers(store).GET!(new Request(url()))).status).toBe(404)
    expect((await handlers(store).GET!(new Request(url().replace(projectContextId, 'PROJECT')))).status).toBe(422)
    expect((await handlers(store).GET!(new Request(url(`/${entryId}`)))).status).toBe(404)
    expect((await handlers({}).DELETE!(new Request(url(), { method: 'DELETE' }))).status).toBe(404)
  })
})
