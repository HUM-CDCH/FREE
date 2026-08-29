import { describe, expect, it, vi } from 'vitest'
import type { BatchSchemaSuggestionRecord } from '../../../packages/db/src/project-store'
import { createProjectOperations } from './_project_operations'

const PROJECT = '51000000-0000-4000-8000-000000000001'
const SUGGESTION = '51000000-0000-4000-8000-000000000002'
const SOURCE = '51000000-0000-4000-8000-000000000004'
const REPRESENTATION = '51000000-0000-4000-8000-000000000005'
const RETRIED_SOURCE = '51000000-0000-4000-8000-000000000006'
const RETRIED_REPRESENTATION = '51000000-0000-4000-8000-000000000007'
const lease = {
  owner: 'worker',
  version: 1,
  expiresAt: new Date('2026-08-19T10:02:00.000Z'),
}

function suggestion(): BatchSchemaSuggestionRecord & { lease: typeof lease } {
  return {
    batchSchemaSuggestionId: SUGGESTION,
    projectContextId: PROJECT,
    selectionKey: 'a'.repeat(64),
    executionStatus: 'RUNNING',
    phase: 'SOURCES',
    proposal: null,
    coverage: null,
    draft: null,
    draftVersion: 0,
    failure: null,
    confirmedSchemaRevisionId: null,
    batchExtractionId: null,
    startedAt: new Date('2026-08-19T10:00:00.000Z'),
    finishedAt: null,
    leaseOwner: lease.owner,
    leaseVersion: lease.version,
    leaseExpiresAt: lease.expiresAt,
    createdAt: new Date('2026-08-19T10:00:00.000Z'),
    sources: [
      {
        sourceDocumentId: SOURCE,
        sourceRepresentationRevisionId: REPRESENTATION,
        descriptor: { artifactReference: 'fixture', artifactSha256: 'a'.repeat(64) },
        executionStatus: 'QUEUED',
        definition: null,
        failure: null,
        startedAt: null,
        finishedAt: null,
      },
    ],
    lease,
  }
}


describe('Project Operations dispatcher', () => {
  it('checkpoints each suggested source and then its merged draft without a request signal', async () => {
    const source = suggestion()
    const completedSource = vi.fn(async () => true)
    const completedMerge = vi.fn(async () => true)
    let claimed = false
    const operations = createProjectOperations(
      {
        claimBatchSchemaSuggestion: vi.fn(async () => {
          if (claimed) return null
          claimed = true
          return source
        }),
        renewBatchSchemaSuggestionLease: vi.fn(async () => true),
        startBatchSchemaSuggestionSource: vi.fn(async () => true),
        completeBatchSchemaSuggestionSource: completedSource,
        startBatchSchemaSuggestionMerge: vi.fn(async () => true),
        completeBatchSchemaSuggestionMerge: completedMerge,
        failBatchSchemaSuggestion: vi.fn(async () => true),
      } as never,
      {
        readMarkdown: vi.fn(async () => ({
          bytes: new TextEncoder().encode('# Source'),
          mediaType: 'text/markdown',
        })),
        generate: vi.fn(async () => ({
          template: { _description: 'One record.', title: 'string' },
          raw: '',
          pages: null,
        })),
      },
    )

    operations.kick()
    await vi.waitFor(() => expect(completedMerge).toHaveBeenCalledOnce())
    expect(completedSource).toHaveBeenCalledOnce()
    expect(completedSource).toHaveBeenCalledWith(
      SUGGESTION,
      SOURCE,
      lease,
      { definition: expect.any(Object) },
      expect.any(Date),
    )
    expect(completedMerge).toHaveBeenCalledWith(
      SUGGESTION,
      lease,
      expect.any(Object),
      expect.any(Date),
    )
  })

  it('skips a successful source checkpoint when processing a retried suggestion', async () => {
    const original = suggestion()
    const source = {
      ...original,
      sources: [
      {
        ...original.sources[0]!,
        executionStatus: 'COMPLETED',
        definition: {
          recordDescription: 'One retained record.',
          schemaNodes: [{ id: 'retained', name: 'retained', type: 'string' }],
        },
        startedAt: new Date('2026-08-19T10:00:00.000Z'),
        finishedAt: new Date('2026-08-19T10:00:01.000Z'),
      },
      {
        ...original.sources[0]!,
        sourceDocumentId: RETRIED_SOURCE,
        sourceRepresentationRevisionId: RETRIED_REPRESENTATION,
      },
      ],
    }
    const checkpoint = async (...arguments_: unknown[]) => {
      void arguments_
      return true
    }
    const startSource = vi.fn(checkpoint)
    const completeSource = vi.fn(checkpoint)
    const completeMerge = vi.fn(checkpoint)
    const readMarkdown = vi.fn(async () => ({
      bytes: new TextEncoder().encode('# Retried source'),
      mediaType: 'text/markdown',
    }))
    let claimed = false
    const operations = createProjectOperations(
      {
        claimBatchSchemaSuggestion: vi.fn(async () => {
          if (claimed) return null
          claimed = true
          return source
        }),
        renewBatchSchemaSuggestionLease: vi.fn(async () => true),
        startBatchSchemaSuggestionSource: startSource,
        completeBatchSchemaSuggestionSource: completeSource,
        startBatchSchemaSuggestionMerge: vi.fn(async () => true),
        completeBatchSchemaSuggestionMerge: completeMerge,
        failBatchSchemaSuggestion: vi.fn(async () => true),
      } as never,
      {
        readMarkdown,
        generate: vi.fn(async () => ({
          template: { _description: 'One record.', retained: 'string' },
          raw: '',
          pages: null,
        })),
      },
    )

    operations.kick()
    await vi.waitFor(() => expect(completeMerge).toHaveBeenCalledOnce())
    expect(readMarkdown).toHaveBeenCalledOnce()
    expect(startSource).toHaveBeenCalledOnce()
    expect(startSource).toHaveBeenCalledWith(
      SUGGESTION,
      RETRIED_SOURCE,
      lease,
      expect.any(Date),
    )
    expect(completeSource).toHaveBeenCalledOnce()
    expect(completeSource.mock.calls[0]?.[1]).toBe(RETRIED_SOURCE)
  })

})
