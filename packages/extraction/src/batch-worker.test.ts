import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BatchExtractionWorker } from './batch-worker.js'
import {
  createClaimedBatchExtractionPersistence,
  createInternalBatchExtractionWorkerStore,
  createResearcherExtractionPersistence,
  type ClaimedBatchExtraction,
  type InternalBatchExtractionWorkerStore,
  type OperationLease,
} from './postgres-persistence.js'

const PROJECT_A = '51000000-0000-4000-8000-000000000001'
const PROJECT_B = '51000000-0000-4000-8000-000000000002'
const BATCH_A = '51000000-0000-4000-8007-000000000001'
const BATCH_B = '51000000-0000-4000-8007-000000000002'
const SOURCE_A = '51000000-0000-4000-8001-000000000001'
const SOURCE_B = '51000000-0000-4000-8001-000000000002'
const REPRESENTATION_A = '51000000-0000-4000-8002-000000000001'
const REPRESENTATION_B = '51000000-0000-4000-8002-000000000002'
const SCHEMA_A = '51000000-0000-4000-8004-000000000001'
const SCHEMA_B = '51000000-0000-4000-8004-000000000002'

function claimedBatch(input: {
  batchExtractionId: string
  projectContextId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  leaseVersion: number
}): ClaimedBatchExtraction {
  const lease: OperationLease = {
    owner: 'durable-worker',
    version: input.leaseVersion,
    expiresAt: new Date('2026-08-20T10:02:00.000Z'),
  }
  return {
    batchExtractionId: input.batchExtractionId,
    projectContextId: input.projectContextId,
    schemaRevisionId: input.schemaRevisionId,
    extractionSchemaId: input.schemaRevisionId,
    extractionSchemaName: 'Fixture schema',
    schemaRevisionNumber: 1,
    strategy: 'ARTICLE',
    executionStatus: 'RUNNING',
    executionFailure: null,
    startedAt: new Date('2026-08-20T10:00:00.000Z'),
    finishedAt: null,
    leaseOwner: lease.owner,
    leaseVersion: lease.version,
    leaseExpiresAt: lease.expiresAt,
    createdAt: new Date('2026-08-20T09:59:00.000Z'),
    members: [
      {
        sourceDocumentId: input.sourceDocumentId,
        sourceRepresentationRevisionId:
          input.sourceRepresentationRevisionId,
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

describe('BatchExtractionWorker internal scope', () => {
  it('exposes worker operations without inheriting researcher or global operations', async () => {
    const database = {} as never
    const packages = {} as never
    const lease: OperationLease = {
      owner: 'durable-worker',
      version: 1,
      expiresAt: new Date('2026-08-20T10:02:00.000Z'),
    }
    const researcher = createResearcherExtractionPersistence(
      '52000000-0000-4000-8000-000000000001',
      database,
      packages,
    )
    const worker = createInternalBatchExtractionWorkerStore(database, packages)
    const claimed = createClaimedBatchExtractionPersistence(
      BATCH_A,
      lease,
      database,
      packages,
    )

    assert.equal('claimBatch' in researcher, false)
    assert.deepEqual(Object.keys(worker).sort(), [
      'claimBatch',
      'completeBatchMember',
      'failBatch',
      'renewBatchLease',
      'startBatchMember',
    ])
    assert.equal('claimBatch' in claimed, false)
    await assert.rejects(
      claimed.scheduleBatch({} as never),
      /cannot perform researcher batch scheduling/,
    )
  })

  it('claims and processes batches across project roots through claimed leases', async () => {
    const batches = [
      claimedBatch({
        batchExtractionId: BATCH_A,
        projectContextId: PROJECT_A,
        sourceDocumentId: SOURCE_A,
        sourceRepresentationRevisionId: REPRESENTATION_A,
        schemaRevisionId: SCHEMA_A,
        leaseVersion: 3,
      }),
      claimedBatch({
        batchExtractionId: BATCH_B,
        projectContextId: PROJECT_B,
        sourceDocumentId: SOURCE_B,
        sourceRepresentationRevisionId: REPRESENTATION_B,
        schemaRevisionId: SCHEMA_B,
        leaseVersion: 8,
      }),
    ]
    const claimed: ClaimedBatchExtraction[] = []
    const started: Array<{
      batchExtractionId: string
      sourceDocumentId: string
      lease: OperationLease
    }> = []
    const completed: typeof started = []
    const executed: Array<{
      claimed: ClaimedBatchExtraction
      batchExtractionId: string
    }> = []
    const controller = new AbortController()
    let next = 0
    const store: InternalBatchExtractionWorkerStore = {
      async claimBatch() {
        const batch = batches[next++] ?? null
        if (batch) claimed.push(batch)
        return batch
      },
      async renewBatchLease() {
        return true
      },
      async startBatchMember(
        batchExtractionId,
        sourceDocumentId,
        lease,
      ) {
        started.push({ batchExtractionId, sourceDocumentId, lease })
        return true
      },
      async completeBatchMember(
        batchExtractionId,
        sourceDocumentId,
        lease,
      ) {
        completed.push({ batchExtractionId, sourceDocumentId, lease })
        if (completed.length === batches.length) controller.abort()
        return true
      },
      async failBatch() {
        return true
      },
    }
    const worker = new BatchExtractionWorker(store, (batch) => ({
      async runBatchMember(input) {
        executed.push({
          claimed: batch,
          batchExtractionId: input.batchExtractionId,
        })
        return {
          disposition: 'created',
          extraction: {} as never,
        }
      },
    }))

    await worker.run(controller.signal)
    await worker.close()

    assert.deepEqual(
      claimed.map((batch) => batch.projectContextId),
      [PROJECT_A, PROJECT_B],
    )
    assert.deepEqual(
      executed.map(({ claimed: batch, batchExtractionId }) => ({
        batchExtractionId,
        lease: batch.lease,
      })),
      batches.map((batch) => ({
        batchExtractionId: batch.batchExtractionId,
        lease: batch.lease,
      })),
    )
    assert.deepEqual(
      started.map(({ batchExtractionId, lease }) => ({
        batchExtractionId,
        lease,
      })),
      batches.map((batch) => ({
        batchExtractionId: batch.batchExtractionId,
        lease: batch.lease,
      })),
    )
    assert.deepEqual(completed, started)
  })

  it('does not execute a member after the claimed lease loses its checkpoint', async () => {
    const batch = claimedBatch({
      batchExtractionId: BATCH_A,
      projectContextId: PROJECT_A,
      sourceDocumentId: SOURCE_A,
      sourceRepresentationRevisionId: REPRESENTATION_A,
      schemaRevisionId: SCHEMA_A,
      leaseVersion: 4,
    })
    const controller = new AbortController()
    let claimCount = 0
    let executions = 0
    const store: InternalBatchExtractionWorkerStore = {
      async claimBatch() {
        claimCount += 1
        return claimCount === 1 ? batch : null
      },
      async renewBatchLease() {
        return false
      },
      async startBatchMember() {
        controller.abort()
        return false
      },
      async completeBatchMember() {
        assert.fail('A member without its lease checkpoint cannot complete.')
      },
      async failBatch() {
        return true
      },
    }
    const worker = new BatchExtractionWorker(store, () => ({
      async runBatchMember() {
        executions += 1
        return { disposition: 'created', extraction: {} as never }
      },
    }))

    await worker.run(controller.signal)
    await worker.close()

    assert.equal(executions, 0)
  })
})
