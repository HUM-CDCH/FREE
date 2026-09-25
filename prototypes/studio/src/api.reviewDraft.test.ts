// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { readExtraction, saveExtractionReviewDraft } from './api'
import { REVIEW_DRAFT_CONFLICT } from './reviewDrafts'
import { useExtraction } from './useExtraction'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import { captureSessionRecovery, clearSessionRecovery, setSessionRecoveryAccount } from './auth/sessionRecovery'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearSessionRecovery() })

it('restores and retries a document decision after its real API request receives 401', async () => {
  const id = '10000000-0000-4000-8000-000000000001'
  const extraction: ExtractionAttempt = {
    extractionId: id, sourceDocumentId: id, sourceRepresentationRevisionId: id, schemaRevisionId: id,
    strategy: 'ARTICLE', executionStatus: 'COMPLETED', outcome: 'SUCCEEDED', complete: true,
    modelAttribution: { provider: 'ollama', modelId: 'fixture' },
    diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 0, finishReason: null, inputTokens: null, outputTokens: null, grounding: null, catalog: null },
    failure: null, resultPayload: { records: [{ title: 'Original' }] },
    evidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor' }],
    reviewable: true, batchExtractionId: null, createdAt: '2026-08-10T00:00:00.000Z', reviewedAt: null, reviewDecisions: [],
  }
  const pending = [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor', reviewedOccurrenceIds: ['occurrence'], action: 'APPROVED' as const, reviewedValue: null }]
  let authenticated = false
  const writes: unknown[] = []
  const fetch = vi.fn(async (_url, init) => {
    if (init.method === 'GET') return Response.json({ extraction, pendingReviewDecisions: pending, reviewDraft: { version: 3, decisions: [] } })
    const draft = JSON.parse(init.body)
    writes.push(draft)
    return authenticated ? Response.json({ ...draft, version: 4 }) : Response.json({}, { status: 401 })
  })
  vi.stubGlobal('fetch', fetch)
  setSessionRecoveryAccount('account-a')
  const { subscribeToAuthenticationRequired } = await import('./auth/authenticatedFetch')
  const unsubscribe = subscribeToAuthenticationRequired(captureSessionRecovery)
  const options = { schemaReady: true, indexing: false, initialAttempt: extraction,
    reviewTarget: { sourceRepresentationId: id, schemaRevisionId: id }, onTerminal: vi.fn(), onError: vi.fn() }
  try {
    const first = renderHook(() => useExtraction(options))
    await waitFor(() => expect(first.result.current.review.loading).toBe(false))
    await waitFor(() => expect(first.result.current.review.decisions).toHaveLength(1))
    act(() => first.result.current.review.setDecision(pending[0].resultPath, 'REJECTED'))
    await waitFor(() => expect(first.result.current.review.draftError).not.toBeNull())
    first.unmount()
    authenticated = true
    setSessionRecoveryAccount('account-a')
    const restored = renderHook(() => useExtraction(options))
    await waitFor(() => expect(writes).toHaveLength(2))
    await waitFor(() => expect(restored.result.current.review.draftSaving).toBe(false))
    expect(restored.result.current.review.decisions[0].action).toBe('REJECTED')
    expect(restored.result.current.review.draftError).toBeNull()
    expect(writes[1]).toEqual({ version: 3, decisions: [{ ...pending[0], action: 'REJECTED' }] })
    expect(sessionStorage.getItem('free.auth.recovery.v1')).toBeNull()
  } finally { unsubscribe() }
})

it('reads server state after an outstanding draft rejects', async () => {
  const first = Promise.withResolvers<Response>()
  const fetch = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(Response.json({ error: { code: 'not_found', message: 'GET reached server' } }, { status: 404 }))
  vi.stubGlobal('fetch', fetch)
  const write = saveExtractionReviewDraft('read-after-conflict', [], 0)
  const read = readExtraction('read-after-conflict')
  first.resolve(Response.json({ error: { code: 'review_conflict', message: 'Conflict' } }, { status: 409 }))
  await expect(write).rejects.toThrow(REVIEW_DRAFT_CONFLICT)
  await expect(read).rejects.toThrow('GET reached server')
  expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(['POST', 'GET'])
})

it('does not send GET if the waiting read was aborted', async () => {
  const first = Promise.withResolvers<Response>()
  const fetch = vi.fn().mockReturnValue(first.promise)
  vi.stubGlobal('fetch', fetch)
  const controller = new AbortController()
  const write = saveExtractionReviewDraft('aborted-read', [], 0)
  const read = readExtraction('aborted-read', controller.signal)
  controller.abort()
  first.resolve(Response.json({ version: 1, decisions: [] }))
  await write
  await expect(read).rejects.toMatchObject({ name: 'AbortError' })
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('captures an unsaved Revert before a 401 redirects, but drops acknowledged drafts', async () => {
  setSessionRecoveryAccount('account-a')
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ version: 4, decisions: [] }))
  vi.stubGlobal('fetch', fetch)
  const { subscribeToAuthenticationRequired } = await import('./auth/authenticatedFetch')
  const unsubscribe = subscribeToAuthenticationRequired(captureSessionRecovery)
  try {
    await expect(saveExtractionReviewDraft('reverted', [], 3)).rejects.toThrow()
    const envelope = JSON.parse(sessionStorage.getItem('free.auth.recovery.v1')!)
    expect(envelope.entries).toContainEqual({ kind: 'extraction-review', resourceId: 'reverted', value: { version: 3, decisions: [] } })
    setSessionRecoveryAccount('account-a')
    await saveExtractionReviewDraft('reverted', [], 3)
    captureSessionRecovery()
    expect(sessionStorage.getItem('free.auth.recovery.v1')).toBeNull()
  } finally { unsubscribe() }
})

it('serializes rapid saves using the version acknowledged by the previous write', async () => {
  const first = Promise.withResolvers<Response>()
  const fetch = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(Response.json({ version: 2, decisions: [] }))
  vi.stubGlobal('fetch', fetch)
  const one = saveExtractionReviewDraft('queued', [], 0)
  const two = saveExtractionReviewDraft('queued', [], 0)
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ version: 0, decisions: [] })
  first.resolve(Response.json({ version: 1, decisions: [] }))
  await Promise.all([one, two])
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ version: 1, decisions: [] })
  expect(fetch.mock.calls[1][1].credentials).toBe('same-origin')
})

it('captures the last acknowledged version and newest decisions when queued writes fail', async () => {
  setSessionRecoveryAccount('account-a')
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ version: 1, decisions: [] }))
    .mockResolvedValueOnce(Response.json({}, { status: 401 }))
  vi.stubGlobal('fetch', fetch)
  const { subscribeToAuthenticationRequired } = await import('./auth/authenticatedFetch')
  const unsubscribe = subscribeToAuthenticationRequired(captureSessionRecovery)
  try {
    const writes = [
      saveExtractionReviewDraft('queue-failure', [], 0),
      saveExtractionReviewDraft('queue-failure', [], 0),
      saveExtractionReviewDraft('queue-failure', [], 0),
    ]
    await Promise.allSettled(writes)
    expect(fetch).toHaveBeenCalledTimes(2)
    const envelope = JSON.parse(sessionStorage.getItem('free.auth.recovery.v1')!)
    expect(envelope.entries[0].value).toEqual({ version: 1, decisions: [] })
  } finally { unsubscribe() }
})

it('does not send queued overwrites after a conflict and lets an explicit retry report the conflict', async () => {
  const fetch = vi.fn().mockImplementation(async () => Response.json({ error: { code: 'review_conflict', message: 'Reload before continuing.' } }, { status: 409 }))
  vi.stubGlobal('fetch', fetch)
  const one = saveExtractionReviewDraft('conflicted', [], 0)
  const two = saveExtractionReviewDraft('conflicted', [], 0)
  const results = await Promise.allSettled([one, two])
  expect(results.every((result) => result.status === 'rejected' && result.reason.message === REVIEW_DRAFT_CONFLICT)).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(1)
  await expect(saveExtractionReviewDraft('conflicted', [], 0)).rejects.toThrow(REVIEW_DRAFT_CONFLICT)
})
