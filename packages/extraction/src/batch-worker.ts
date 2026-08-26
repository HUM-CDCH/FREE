import { createHash, randomUUID } from 'node:crypto'
import { ExtractionError } from './errors.js'
import type { ExtractionExecutionModule } from './dependencies.js'
import type {
  ClaimedBatchExtraction,
  InternalBatchExtractionWorkerStore,
} from './postgres-persistence.js'

const LEASE_MS = 2 * 60 * 1000
const LEASE_RENEW_MS = 30 * 1000
const MEMBER_TIMEOUT_MS = 10 * 60 * 1000


function fingerprintId(value: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const variant = (['8', '9', 'a', 'b'] as const)[parseInt(hash[16]!, 16) & 3]
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
function durableFailure(error: unknown): Readonly<{ code: string; message: string }> {
  const code = error instanceof ExtractionError ? error.code : 'unexpected_failure'
  const message = code === 'unexpected_failure'
    ? 'The operation failed unexpectedly.'
    : error instanceof Error ? error.message : 'The operation failed unexpectedly.'
  return { code, message: message.slice(0, 512) }
}
function leaseGuard(
  renew: (expiresAt: Date) => Promise<boolean>,
  now: () => Date,
  outerSignal: AbortSignal,
) {
  const lost = new AbortController()
  let renewing = false
  const timer = setInterval(() => {
    if (renewing || lost.signal.aborted || outerSignal.aborted) return
    renewing = true
    void renew(new Date(now().getTime() + LEASE_MS))
      .then((owned) => { if (!owned) lost.abort() })
      .catch(() => lost.abort())
      .finally(() => { renewing = false })
  }, LEASE_RENEW_MS)
  const signal = AbortSignal.any([outerSignal, lost.signal])
  return {
    signal,
    memberSignal: () => AbortSignal.any([signal, AbortSignal.timeout(MEMBER_TIMEOUT_MS)]),
    lost: () => lost.signal.aborted,
    stop: () => clearInterval(timer),
  }
}

export class BatchExtractionWorker {
  private readonly owner = randomUUID()
  private readonly closing = new AbortController()
  private closed = false
  private wakeVersion = 0
  private waiter: (() => void) | null = null
  private readonly persistence: InternalBatchExtractionWorkerStore
  private readonly createExtractions: (
    batch: ClaimedBatchExtraction,
  ) => Pick<ExtractionExecutionModule, 'runBatchMember'>
  private readonly now: () => Date

  constructor(
    persistence: InternalBatchExtractionWorkerStore,
    createExtractions: (
      batch: ClaimedBatchExtraction,
    ) => Pick<ExtractionExecutionModule, 'runBatchMember'>,
    now: () => Date = () => new Date(),
  ) {
    this.persistence = persistence
    this.createExtractions = createExtractions
    this.now = now
  }

  wake(): void {
    this.wakeVersion += 1
    this.waiter?.()
    this.waiter = null
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.closing.abort()
    this.wake()
  }
  async run(outerSignal: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([outerSignal, this.closing.signal])
    let observedWake = -1
    while (!signal.aborted) {
      let claimed = false
      for (;;) {
        if (signal.aborted) return
        const startedAt = this.now()
        const batch = await this.persistence.claimBatch(
          this.owner,
          startedAt,
          new Date(startedAt.getTime() + LEASE_MS),
        )
        if (!batch) break
        claimed = true
        await this.runBatch(batch, signal)
      }
      if (claimed) continue
      if (observedWake !== this.wakeVersion) {
        observedWake = this.wakeVersion
        continue
      }
      await new Promise<void>((resolve) => {
        const onAbort = () => { this.waiter = null; resolve() }
        this.waiter = () => { signal.removeEventListener('abort', onAbort); resolve() }
        signal.addEventListener('abort', onAbort, { once: true })
        if (this.closed || signal.aborted || observedWake !== this.wakeVersion)
          this.waiter()
      })
    }
  }

  private async runBatch(batch: ClaimedBatchExtraction, outerSignal: AbortSignal): Promise<void> {
    const guard = leaseGuard(
      (expiresAt) => this.persistence.renewBatchLease(batch.batchExtractionId, batch.lease, expiresAt),
      this.now,
      outerSignal,
    )
    const extractions = this.createExtractions(batch)
    try {
      for (const member of batch.members) {
        if (member.executionStatus === 'COMPLETED') continue
        if (!await this.persistence.startBatchMember(
          batch.batchExtractionId,
          member.sourceDocumentId,
          batch.lease,
          this.now(),
        )) return
        try {
          await extractions.runBatchMember({
            extractionId: fingerprintId([
              'batch-member-extraction',
              batch.batchExtractionId,
              member.sourceRepresentationRevisionId,
            ]),
            sourceRepresentationRevisionId: member.sourceRepresentationRevisionId,
            schemaRevisionId: batch.schemaRevisionId,
            strategy: batch.strategy,
            batchExtractionId: batch.batchExtractionId,
          }, guard.memberSignal())
          if (!await this.persistence.completeBatchMember(
            batch.batchExtractionId,
            member.sourceDocumentId,
            batch.lease,
            { completed: true },
            this.now(),
          )) return
        } catch (error) {
          if (guard.signal.aborted) return
          if (!await this.persistence.completeBatchMember(
            batch.batchExtractionId,
            member.sourceDocumentId,
            batch.lease,
            { failure: durableFailure(error) },
            this.now(),
          )) return
        }
      }
    } catch (error) {
      if (!guard.lost() && !guard.signal.aborted) await this.persistence.failBatch(
        batch.batchExtractionId,
        batch.lease,
        durableFailure(error),
        this.now(),
      )
    } finally {
      guard.stop()
    }
  }
}
