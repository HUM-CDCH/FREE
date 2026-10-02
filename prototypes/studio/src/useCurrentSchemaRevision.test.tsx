// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcknowledgedSchemaRevision } from './schemaSaveCoordinator'
import type { SourceCoverage } from '../shared/schemaSuggestionSource.contract'
import { useDurableCurrentSchemaRevision } from './useCurrentSchemaRevision'
import {
  captureSessionRecovery,
  clearSessionRecovery,
  setSessionRecoveryAccount,
} from './auth/sessionRecovery'
import * as revisions from './schemaRevisions'

vi.mock('./schemaRevisions', async (importOriginal) => ({
  // An unmounted workspace still starts its pending save, whose failure the save engine classifies.
  SchemaRevisionConflictError: (await importOriginal<typeof import('./schemaRevisions')>()).SchemaRevisionConflictError,
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
    recordScope: 'document',
    schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
  }
}

function scope(initial: (AcknowledgedSchemaRevision & { sourceCoverage?: SourceCoverage | null }) | null) {
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

describe('durable schema record scope across reloads and navigation', () => {
  const DRAFT = {
    recordDescription: 'Unsaved researcher draft.',
    schemaNodes: [{ id: 'year', name: 'year', type: 'integer' as const }],
  }
  const appended = (expected: number, definition: typeof DRAFT, recordScope?: 'document' | 'records') => ({
    ...revision(expected + 1, definition.recordDescription),
    schemaNodes: definition.schemaNodes,
    recordScope: recordScope ?? ('document' as const),
    origin: 'researcher-edit' as const,
    createdAt: '2026-08-01T12:00:00.000Z',
  })

  it('reads the saved scope back from the acknowledged revision after a reload', async () => {
    vi.mocked(revisions.appendSchemaRevision).mockImplementation(
      async (_project, _schema, expected, definition, _coverage, _signal, recordScope) =>
        appended(expected, definition as typeof DRAFT, recordScope),
    )
    const first = renderHook(() => useDurableCurrentSchemaRevision(scope(revision(1))))
    act(() => first.result.current.setRecordScope('records'))
    await act(async () => {
      await first.result.current.flush()
    })
    const acknowledged = first.result.current.snapshot().save!.acknowledged
    expect(acknowledged).toMatchObject({ revisionNumber: 2, recordScope: 'records' })
    first.unmount()

    // A reload opens the Current Schema Revision the server acknowledged.
    const reloaded = renderHook(() => useDurableCurrentSchemaRevision(scope(acknowledged)))
    expect(reloaded.result.current.snapshot()).toMatchObject({
      recordScope: 'records',
      save: { status: 'saved', recordScope: 'records' },
    })
    expect(revisions.appendSchemaRevision).toHaveBeenCalledTimes(1)
  })

  it('starts a debounced edit\'s save when the workspace unmounts instead of dropping it', async () => {
    vi.mocked(revisions.appendSchemaRevision).mockImplementation(
      async (_project, _schema, expected, definition, _coverage, _signal, recordScope) =>
        appended(expected, definition as typeof DRAFT, recordScope),
    )
    const first = renderHook(() => useDurableCurrentSchemaRevision(scope(revision(1))))
    act(() => first.result.current.replaceDraft(DRAFT, 'Edit'))
    expect(revisions.appendSchemaRevision).not.toHaveBeenCalled()

    first.unmount()
    await act(async () => {})

    expect(revisions.appendSchemaRevision).toHaveBeenCalledExactlyOnceWith(
      PROJECT_ID, SCHEMA_ID, 1, DRAFT, undefined, undefined, undefined,
    )
  })

  it('recovers an unsaved scope choice with its draft and saves both in one revision', async () => {
    // The first tab's save never acknowledges before the session expires.
    vi.mocked(revisions.appendSchemaRevision).mockImplementationOnce(() => new Promise(() => {}))
    const initial = revision(1)
    const first = renderHook(() => useDurableCurrentSchemaRevision(scope(initial)))
    act(() => first.result.current.replaceDraft(DRAFT, 'Edit'))
    act(() => first.result.current.setRecordScope('records'))
    expect(first.result.current.snapshot().save?.status).toBe('saving')
    act(() => captureSessionRecovery())
    expect(JSON.parse(sessionStorage.getItem('free.auth.recovery.v1')!)).toMatchObject({
      entries: [{ kind: 'schema-draft', value: { acknowledgedRevisionNumber: 1, draft: DRAFT, recordScope: 'records' } }],
    })
    first.unmount()

    vi.mocked(revisions.appendSchemaRevision).mockReset()
    vi.mocked(revisions.appendSchemaRevision).mockImplementation(
      async (_project, _schema, expected, definition, _coverage, _signal, recordScope) =>
        appended(expected, definition as typeof DRAFT, recordScope),
    )
    setSessionRecoveryAccount(ACCOUNT_ID)
    const restored = renderHook(() => useDurableCurrentSchemaRevision(scope(initial)))
    expect(restored.result.current.snapshot()).toMatchObject({ draft: DRAFT, recordScope: 'records' })
    await act(async () => {
      await restored.result.current.flush()
    })

    expect(revisions.appendSchemaRevision).toHaveBeenCalledExactlyOnceWith(
      PROJECT_ID, SCHEMA_ID, 1, DRAFT, undefined, undefined, 'records',
    )
    expect(restored.result.current.snapshot().save).toMatchObject({
      status: 'saved',
      acknowledged: { revisionNumber: 2, recordScope: 'records' },
    })
  })
})

describe('durable schema source declaration', () => {
  const EXCERPTED = { complete: false as const, sourceCharacters: 50_040, omitted: [{ page: 1, start: 23_000, end: 27_040 }] }
  const saved = (revisionNumber: number, recordDescription: string) => ({
    ...revision(revisionNumber, recordDescription),
    origin: 'researcher-edit' as const,
    createdAt: '2026-08-01T12:00:00.000Z',
  })

  it('opens a reopened revision with the declaration it was saved with', () => {
    const { result } = renderHook(() =>
      useDurableCurrentSchemaRevision(scope({ ...revision(3), sourceCoverage: EXCERPTED })),
    )
    expect(result.current.snapshot().sourceCoverage).toEqual(EXCERPTED)
  })

  it('saves a generation with its declaration, onto an existing schema or as its first revision', async () => {
    vi.mocked(revisions.appendSchemaRevision).mockImplementation(async (_project, _schema, expected, definition) =>
      saved(expected + 1, definition.recordDescription))
    vi.mocked(revisions.initializeSchemaRevision).mockImplementation(async (_project, definition) =>
      saved(1, definition.recordDescription))
    const generate = async (initial: AcknowledgedSchemaRevision | null) => {
      const { result } = renderHook(() => useDurableCurrentSchemaRevision(scope(initial)))
      await act(() => result.current.generate(async (_signal, declareSourceCoverage) => {
        declareSourceCoverage(EXCERPTED)
        return { _description: 'Generated.', place: 'string' }
      }))
    }

    await generate(revision(3))
    await generate(null)

    expect(vi.mocked(revisions.appendSchemaRevision).mock.calls.map((call) => call.slice(2, 3).concat(call.slice(4, 5))))
      .toEqual([[3, EXCERPTED]])
    expect(vi.mocked(revisions.initializeSchemaRevision).mock.calls.map((call) => call[2])).toEqual([EXCERPTED])
  })
})
