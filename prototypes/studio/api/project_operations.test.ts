import { describe, expect, it, vi } from 'vitest'
import type {
  BatchExtractionRecord,
  BatchSchemaSuggestionRecord,
} from '../../../packages/db/src/project-store'
import { createProjectOperations } from './_project_operations'

const PROJECT = '51000000-0000-4000-8000-000000000001'
const SUGGESTION = '51000000-0000-4000-8000-000000000002'
const BATCH = '51000000-0000-4000-8000-000000000003'
const SOURCE = '51000000-0000-4000-8000-000000000004'
const REPRESENTATION = '51000000-0000-4000-8000-000000000005'
const SCHEMA = '51000000-0000-4000-8000-000000000006'
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

function batch(): BatchExtractionRecord & { lease: typeof lease } {
  return {
    batchExtractionId: BATCH,
    projectContextId: PROJECT,
    schemaRevisionId: SCHEMA,
    extractionSchemaId: '51000000-0000-4000-8000-000000000007',
    extractionSchemaName: 'Fields',
    schemaRevisionNumber: 1,
    strategy: 'ARTICLE',
    executionStatus: 'RUNNING',
    executionFailure: null,
    startedAt: new Date('2026-08-19T10:00:00.000Z'),
    finishedAt: null,
    leaseOwner: lease.owner,
    leaseVersion: lease.version,
    leaseExpiresAt: lease.expiresAt,
    createdAt: new Date('2026-08-19T10:00:00.000Z'),
    members: [
      {
        sourceDocumentId: SOURCE,
        sourceRepresentationRevisionId: REPRESENTATION,
        executionStatus: 'QUEUED',
        executionFailure: null,
        startedAt: null,
        finishedAt: null,
        latestExtraction: null,
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
    const operations = createProjectOperations({
      store: {
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
        claimBatchExtraction: vi.fn(async () => null),
        renewBatchExtractionLease: vi.fn(async () => true),
        startBatchExtractionMember: vi.fn(async () => true),
        completeBatchExtractionMember: vi.fn(async () => true),
        failBatchExtraction: vi.fn(async () => true),
      } as never,
      readMarkdown: vi.fn(async () => ({
        bytes: new TextEncoder().encode('# Source'),
        mediaType: 'text/markdown',
      })),
      generate: vi.fn(async () => ({
        template: { _description: 'One record.', title: 'string' },
        raw: '',
        pages: null,
      })),
      executeExtraction: vi.fn(),
    })

    operations.kick()
    await vi.waitFor(() => expect(completedMerge).toHaveBeenCalledOnce())
    expect(completedSource).toHaveBeenCalledOnce()
  })

  it('runs a queued Batch member through the direct Extraction executor', async () => {
    const queued = batch()
    const complete = vi.fn(async () => true)
    let claimed = false
    const executeExtraction = vi.fn(async () => ({ extractionId: 'unused' }))
    const operations = createProjectOperations({
      store: {
        claimBatchSchemaSuggestion: vi.fn(async () => null),
        renewBatchSchemaSuggestionLease: vi.fn(async () => true),
        startBatchSchemaSuggestionSource: vi.fn(async () => true),
        completeBatchSchemaSuggestionSource: vi.fn(async () => true),
        startBatchSchemaSuggestionMerge: vi.fn(async () => true),
        completeBatchSchemaSuggestionMerge: vi.fn(async () => true),
        failBatchSchemaSuggestion: vi.fn(async () => true),
        claimBatchExtraction: vi.fn(async () => {
          if (claimed) return null
          claimed = true
          return queued
        }),
        renewBatchExtractionLease: vi.fn(async () => true),
        startBatchExtractionMember: vi.fn(async () => true),
        completeBatchExtractionMember: complete,
        failBatchExtraction: vi.fn(async () => true),
      } as never,
      executeExtraction: executeExtraction as never,
    })

    operations.kick()
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
    expect(executeExtraction).toHaveBeenCalledOnce()
    expect((executeExtraction.mock.calls as unknown[][])[0][0]).toEqual({
      id: expect.any(String),
      sourceRepresentationRevisionId: REPRESENTATION,
      schemaRevisionId: SCHEMA,
      strategy: 'ARTICLE',
      batchExtractionId: BATCH,
    })
  })
})
