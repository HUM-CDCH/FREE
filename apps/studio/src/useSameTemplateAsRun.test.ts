// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SchemaEditorController, SchemaEditorSnapshot } from './currentSchemaRevision'
import { useSameTemplateAsRun } from './useSameTemplateAsRun'

const PROJECT = '61000000-0000-4000-8000-000000000001'
const SCHEMA = '61000000-0000-4000-8003-000000000001'
const RUN_REVISION = '61000000-0000-4000-8004-000000000001'
const CURRENT_REVISION = '61000000-0000-4000-8004-000000000002'
const nodes = [{ id: 'sender', name: 'sender', type: 'string' as const }]

afterEach(() => vi.unstubAllGlobals())

function controller(snapshot: Partial<SchemaEditorSnapshot>): SchemaEditorController {
  const snap = {
    draft: { recordDescription: 'One letter.', schemaNodes: nodes },
    extractableSchemaRevisionId: CURRENT_REVISION,
    extractionSchemaId: SCHEMA,
    recordScope: 'document',
    ...snapshot,
  } as SchemaEditorSnapshot
  return {
    snapshot: () => snap,
    subscribe: () => () => {},
    operationScope: () => ({ projectContextId: PROJECT, extractionSchemaId: SCHEMA }),
  } as unknown as SchemaEditorController
}

function serveRunRevision(revision: { recordDescription?: string; recordScope?: string; status?: number } = {}) {
  const fetch = vi.fn(async () => revision.status
    ? Response.json({ error: { code: 'not_found', message: 'Schema Revision was not found.' } }, { status: revision.status })
    : Response.json({ revision: {
        schemaRevisionId: RUN_REVISION, extractionSchemaId: SCHEMA, revisionNumber: 1, origin: 'suggestion',
        createdAt: '2026-11-10T09:00:00.000Z', stabilisedAt: null,
        recordDescription: revision.recordDescription ?? 'One letter.', recordScope: revision.recordScope ?? 'document',
        schemaNodes: nodes,
      } }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('useSameTemplateAsRun', () => {
  it('reads another revision defining the same fields, description and scope as the same template', async () => {
    const fetch = serveRunRevision()
    const schema = controller({})
    const { result } = renderHook(() => useSameTemplateAsRun(schema, RUN_REVISION))
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).toBe(true))
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain(`/api/schema-revisions/${RUN_REVISION}?`)
  })

  it.each([
    ['description', { recordDescription: 'Another letter.' }],
    ['Article/Catalog choice', { recordScope: 'records' }],
  ])('reads a revision with another %s as a changed template', async (_, revision) => {
    serveRunRevision(revision)
    const schema = controller({})
    const { result } = renderHook(() => useSameTemplateAsRun(schema, RUN_REVISION))
    await waitFor(() => expect(result.current).toBe(false))
  })

  it('stays unknown when the run\'s revision cannot be read, and reads nothing for the current revision itself', async () => {
    const schema = controller({})
    const missing = serveRunRevision({ status: 404 })
    const unread = renderHook(() => useSameTemplateAsRun(schema, RUN_REVISION))
    await waitFor(() => expect(missing).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(unread.result.current).toBeNull()
    unread.unmount()

    const fetch = serveRunRevision()
    const current = renderHook(() => useSameTemplateAsRun(schema, CURRENT_REVISION))
    expect(current.result.current).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
})
