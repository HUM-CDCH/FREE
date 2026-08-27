// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcknowledgedSchemaRevision } from './schemaSaveCoordinator'
import { useDurableCurrentSchemaRevision } from './useCurrentSchemaRevision'
import {
  captureSessionRecovery,
  clearSessionRecovery,
  setSessionRecoveryAccount,
} from './auth/sessionRecovery'
import * as revisions from './schemaRevisions'

vi.mock('./schemaRevisions', () => ({
  appendSchemaRevision: vi.fn(),
  getSchemaRevision: vi.fn(),
  initializeSchemaRevision: vi.fn(),
  listSchemaRevisions: vi.fn(async () => []),
}))

const ACCOUNT_ID = '99999999-9999-4999-8999-999999999999'
const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const SCHEMA_ID = '22222222-2222-4222-8222-222222222222'

function revision(
  revisionNumber: number,
  recordDescription = `Server revision ${revisionNumber}.`,
): AcknowledgedSchemaRevision {
  return {
    extractionSchemaId: SCHEMA_ID,
    schemaRevisionId: `33333333-3333-4333-8333-${String(revisionNumber).padStart(12, '0')}`,
    revisionNumber,
    recordDescription,
    schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
  }
}

function scope(initial: AcknowledgedSchemaRevision | null) {
  return {
    projectContextId: PROJECT_ID,
    extractionSchema: initial,
    sourceRepresentationId: '44444444-4444-4444-8444-444444444444',
    debounceMs: 60_000,
  }
}

beforeEach(() => {
  cleanup()
  clearSessionRecovery()
  sessionStorage.clear()
  setSessionRecoveryAccount(ACCOUNT_ID)
  vi.mocked(revisions.initializeSchemaRevision).mockReset()
  vi.mocked(revisions.appendSchemaRevision).mockReset()
  vi.mocked(revisions.listSchemaRevisions).mockClear()
})

describe('durable schema authentication recovery', () => {
  it('restores an unsaved draft against the same acknowledged revision', () => {
    const initial = revision(1)
    const first = renderHook(() => useDurableCurrentSchemaRevision(scope(initial)))
    act(() =>
      first.result.current.replaceDraft(
        {
          recordDescription: 'Unsaved researcher draft.',
          schemaNodes: [{ id: 'year', name: 'year', type: 'integer' }],
        },
        'Edit',
      ),
    )
    expect(first.result.current.snapshot().save?.status).toBe('dirty')
    act(() => captureSessionRecovery())
    first.unmount()

    setSessionRecoveryAccount(ACCOUNT_ID)
    const restored = renderHook(() =>
      useDurableCurrentSchemaRevision(scope(initial)),
    )
    expect(restored.result.current.snapshot().draft).toEqual({
      recordDescription: 'Unsaved researcher draft.',
      schemaNodes: [{ id: 'year', name: 'year', type: 'integer' }],
    })
    expect(restored.result.current.snapshot().save?.status).toBe('dirty')
    expect(sessionStorage.getItem('free.auth.recovery.v1')).toBeNull()
  })

  it('restores a draft captured after a new schema receives its UUID', async () => {
    const acknowledged = revision(1, 'Initial schema.')
    vi.mocked(revisions.initializeSchemaRevision).mockResolvedValue(
      acknowledged as never,
    )
    const first = renderHook(() =>
      useDurableCurrentSchemaRevision(scope(null)),
    )
    await act(() =>
      first.result.current.generate(async () => ({
        _description: 'Initial schema.',
        title: 'string',
      })),
    )
    act(() =>
      first.result.current.replaceDraft(
        {
          recordDescription: 'Unsaved post-initialization draft.',
          schemaNodes: [{ id: 'year', name: 'year', type: 'integer' }],
        },
        'Edit',
      ),
    )
    expect(first.result.current.snapshot().save).toMatchObject({
      status: 'dirty',
      acknowledged: {
        extractionSchemaId: SCHEMA_ID,
        revisionNumber: 1,
      },
    })
    act(() => captureSessionRecovery())
    expect(
      JSON.parse(sessionStorage.getItem('free.auth.recovery.v1')!),
    ).toMatchObject({
      entries: [{
        kind: 'schema-draft',
        resourceId: `${PROJECT_ID}/new/44444444-4444-4444-8444-444444444444`,
        value: {
          extractionSchemaId: SCHEMA_ID,
          acknowledgedRevisionNumber: 1,
        },
      }],
    })
    first.unmount()

    setSessionRecoveryAccount(ACCOUNT_ID)
    const restored = renderHook(() =>
      useDurableCurrentSchemaRevision(scope(acknowledged)),
    )

    expect(restored.result.current.snapshot().draft?.recordDescription).toBe(
      'Unsaved post-initialization draft.',
    )
    expect(restored.result.current.snapshot().save?.status).toBe('dirty')
    expect(sessionStorage.getItem('free.auth.recovery.v1')).toBeNull()
  })

  it('keeps a newer server acknowledgement authoritative', () => {
    const first = renderHook(() =>
      useDurableCurrentSchemaRevision(scope(revision(1))),
    )
    act(() =>
      first.result.current.replaceDraft(
        {
          recordDescription: 'Stale local draft.',
          schemaNodes: [{ id: 'year', name: 'year', type: 'integer' }],
        },
        'Edit',
      ),
    )
    act(() => captureSessionRecovery())
    first.unmount()

    setSessionRecoveryAccount(ACCOUNT_ID)
    const current = revision(2, 'Newer server revision.')
    const reopened = renderHook(() =>
      useDurableCurrentSchemaRevision(scope(current)),
    )
    expect(reopened.result.current.snapshot().draft?.recordDescription).toBe(
      'Newer server revision.',
    )
    expect(reopened.result.current.snapshot().save?.status).toBe('saved')
    expect(sessionStorage.getItem('free.auth.recovery.v1')).toBeNull()
  })
})
