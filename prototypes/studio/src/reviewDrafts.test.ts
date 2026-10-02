// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { forgetReviewDraft, recoverReviewDraft, rememberReviewDraft, restoreReviewDraft } from './reviewDrafts'
import { captureSessionRecovery, clearSessionRecovery, setSessionRecoveryAccount } from './auth/sessionRecovery'

const decision = { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor', reviewedOccurrenceIds: ['occurrence'], action: 'REJECTED' as const, reviewedValue: null }
afterEach(() => { forgetReviewDraft('extraction'); forgetReviewDraft('e1'); clearSessionRecovery() })

function capture(decisions = [decision], version = 1) {
  setSessionRecoveryAccount('account-a')
  rememberReviewDraft('extraction', { version, decisions })
  captureSessionRecovery()
}

it('retries a recovered Revert against its acknowledged version', () => {
  capture([])
  const recovered = recoverReviewDraft('extraction', { version: 1, decisions: [decision] }, [decision])
  expect(recovered.retry).toBe(true)
  expect(recovered.conflict).toBe(false)
  expect(recovered.touchedPaths.size).toBe(0)
})

it('recognizes an acknowledged save even if the response was lost', () => {
  capture()
  expect(recoverReviewDraft('extraction', { version: 2, decisions: [decision] }, [decision])).toMatchObject({ retry: false, conflict: false, version: 2 })
})

it('keeps conflicting recovered decisions without updating their base version', () => {
  capture()
  const recovered = recoverReviewDraft('extraction', { version: 2, decisions: [] }, [decision])
  expect(recovered).toMatchObject({ retry: false, conflict: true, version: 1, decisions: [decision] })
  captureSessionRecovery()
  expect(JSON.parse(sessionStorage.getItem('free.auth.recovery.v1')!).entries[0].value.version).toBe(1)
})

it('rejects recovery from a different account, including retained capture callbacks', () => {
  capture()
  setSessionRecoveryAccount('account-b')
  captureSessionRecovery()
  expect(recoverReviewDraft('extraction', { version: 2, decisions: [] }, [decision]).touchedPaths.size).toBe(0)
})

it('does not revive failed changes after explicit logout and a later login', () => {
  capture()
  clearSessionRecovery()
  setSessionRecoveryAccount('account-a')
  captureSessionRecovery()
  expect(sessionStorage.getItem('free.auth.recovery.v1')).toBeNull()
})

it.each([
  { ...decision, evidenceAnchorId: 'foreign' },
  { ...decision, reviewedOccurrenceIds: ['foreign'] },
  { ...decision, resultPath: ['records', 0, 'foreign'] },
])('rejects recovered decisions with mismatched authority: %j', (invalid) => {
  capture([invalid])
  expect(recoverReviewDraft('extraction', { version: 1, decisions: [] }, [decision]).touchedPaths.size).toBe(0)
})

it('combines server-saved decisions with pending fields without treating defaults as reviewed', () => {
  const prepared = ['title', 'year'].map((name) => ({ resultPath: ['records', 0, name], evidenceAnchorId: 'anchor', reviewedOccurrenceIds: [], action: 'APPROVED' as const, reviewedValue: null }))
  const edited = { ...prepared[0], action: 'EDITED' as const, reviewedValue: 'Corrected' }
  const restored = restoreReviewDraft({ decisions: [edited] }, prepared)
  expect(restored.decisions).toEqual([edited, prepared[1]])
  expect([...restored.touchedPaths]).toEqual([JSON.stringify(prepared[0].resultPath)])
  expect(restoreReviewDraft(undefined, prepared).touchedPaths.size).toBe(0)
})

describe('review drafts from before the sample workbench was removed', () => {
  const local = { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'a_p1_1', reviewedOccurrenceIds: ['o1'], action: 'REJECTED' as const, reviewedValue: null }
  const server = { ...local, action: 'APPROVED' as const }

  // The local decision differs from the server's, so a lenient parse would recover it as a conflict at version 2.
  it.each([
    ['a draft that still carries pairings', { version: 2, decisions: [local], pairings: [{ record: 0, extractionId: 'old', sourceRecord: 0 }] }],
    ['a decision that still carries carriedFrom', { version: 2, decisions: [{ ...local, carriedFrom: { extractionId: 'old', sourcePathKey: '["records",0,"title"]' } }] }],
  ])('drops a local draft with %s and keeps the server state', (_name, legacy) => {
    setSessionRecoveryAccount('account-a')
    rememberReviewDraft('e1', legacy as never)
    captureSessionRecovery()
    const recovered = recoverReviewDraft('e1', { version: 3, decisions: [server] }, [server])
    expect(recovered.decisions).toEqual([server])
    expect(recovered.retry).toBe(false)
    expect(recovered.conflict).toBe(false)
    expect(recovered.version).toBe(3)
    expect('pairings' in recovered).toBe(false)
  })
})
