import { randomUUID } from 'node:crypto'
import type {
  ClaimedExtractionJob,
  ExtractionJobExecutor,
  ExtractionJobFailure,
  InternalExtractionJobStore,
} from './dependencies.js'
import { ExtractionError, extractionError } from './errors.js'

const LEASE_MS = 2 * 60 * 1000
const LEASE_RENEW_MS = 30 * 1000
const IDLE_POLL_MS = 5 * 1000
const MEMBER_TIMEOUT_MS = 10 * 60 * 1000
// Large catalogues make a values call and a grounding call per entry.
const CATALOG_MEMBER_TIMEOUT_MS = 3 * 60 * 60 * 1000

function durableFailure(
  error: unknown,
  checkpointed: boolean,
  cancelled: boolean,
): ExtractionJobFailure {
  const mapped = cancelled
    ? new ExtractionError('cancelled', 'The Extraction was cancelled.')
    : extractionError(error)
  return {
    code: mapped.code,
    message: mapped.code === 'extraction_failed'
      ? 'The operation failed unexpectedly.'
      : mapped.message.slice(0, 512),
    phase: checkpointed ? 'grounding' : 'extracting',
  }
}

export class ExtractionJobWorker {
  private readonly owner = randomUUID()
  private readonly closing = new AbortController()
  private active: { jobId: string; controller: AbortController } | null = null
  private closed = false
  private wakeVersion = 0
  private waiter: (() => void) | null = null
  private readonly store: InternalExtractionJobStore
  private readonly executeJob: ExtractionJobExecutor
  private readonly now: () => Date

  constructor(
    store: InternalExtractionJobStore,
    executeJob: ExtractionJobExecutor,
    now: () => Date = () => new Date(),
  ) {
    this.store = store
    this.executeJob = executeJob
    this.now = now
  }

  wake(): void {
    this.wakeVersion += 1
    this.waiter?.()
    this.waiter = null
  }

  abort(jobId: string): void {
    if (this.active?.jobId === jobId)
      this.active.controller.abort(new ExtractionError('cancelled', 'The Extraction was cancelled.'))
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
      const startedAt = this.now()
      // ponytail: strict priority is intentionally serial and can starve batch
      // jobs; add fair scheduling only when measured batch latency warrants it.
      const job = await this.store.claim(
        this.owner,
        startedAt,
        new Date(startedAt.getTime() + LEASE_MS),
      )
      if (job) {
        await this.runJob(job, signal)
        continue
      }
      if (observedWake !== this.wakeVersion) {
        observedWake = this.wakeVersion
        continue
      }
      await this.waitForWake(signal, observedWake)
    }
  }

  private waitForWake(signal: AbortSignal, observedWake: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, IDLE_POLL_MS)
      const onAbort = () => done()
      const wake = () => done()
      const self = this
      function done() {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        if (self.waiter === wake) self.waiter = null
        resolve()
      }
      this.waiter = wake
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted || observedWake !== this.wakeVersion) done()
    })
  }

  private async runJob(
    job: ClaimedExtractionJob,
    outerSignal: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController()
    this.active = { jobId: job.input.extractionId, controller }
    let leaseState: 'owned' | 'cancelled' | 'lost' = 'owned'
    let checkpointed = job.checkpoint !== null
    let renewing = false
    const renew = async () => {
      if (renewing || leaseState !== 'owned' || outerSignal.aborted) return
      renewing = true
      try {
        leaseState = await this.store.renew(
          job.input.extractionId,
          job.lease,
          new Date(this.now().getTime() + LEASE_MS),
        )
        if (leaseState !== 'owned') controller.abort()
      } catch {
        leaseState = 'lost'
        controller.abort()
      } finally {
        renewing = false
      }
    }
    const timer = setInterval(() => void renew(), LEASE_RENEW_MS)
    const timeout = AbortSignal.timeout(
      job.input.kind !== 'retry' && job.input.strategy === 'CATALOG'
        ? CATALOG_MEMBER_TIMEOUT_MS
        : job.input.kind === 'retry'
          ? CATALOG_MEMBER_TIMEOUT_MS
          : MEMBER_TIMEOUT_MS,
    )
    const signal = AbortSignal.any([outerSignal, controller.signal, timeout])
    try {
      const extraction = await this.executeJob(
        job.input,
        job.checkpoint,
        async (checkpoint) => {
          if (!await this.store.checkpoint(
            job.input.extractionId,
            job.lease,
            checkpoint,
          )) throw new ExtractionError('cancelled', 'The Extraction lease was lost.')
          checkpointed = true
        },
        signal,
      )
      await renew()
      if (outerSignal.aborted || (leaseState as 'owned' | 'cancelled' | 'lost') === 'lost') return
      if (leaseState !== 'owned' || signal.aborted)
        throw signal.reason ?? new ExtractionError('cancelled', 'The Extraction was cancelled.')
      const completed = await this.store.complete(
        job.input.extractionId,
        job.lease,
        extraction,
        this.now(),
      )
      if (!completed)
        throw new ExtractionError('cancelled', 'The Extraction lease was lost.')
    } catch (error) {
      if (outerSignal.aborted) return
      await renew()
      if ((leaseState as 'owned' | 'cancelled' | 'lost') === 'lost') return
      await this.store.fail(
        job.input.extractionId,
        job.lease,
        durableFailure(
          error,
          checkpointed,
          (leaseState as 'owned' | 'cancelled' | 'lost') === 'cancelled' || controller.signal.aborted,
        ),
        this.now(),
      )
    } finally {
      clearInterval(timer)
      if (this.active?.jobId === job.input.extractionId) this.active = null
    }
  }
}
