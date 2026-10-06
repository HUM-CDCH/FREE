import { describe, expect, it, vi } from 'vitest'
import { awaitWorkflowOutcome } from './workflowOutcome.js'

describe('awaitWorkflowOutcome', () => {
  it('returns a finished workflow\'s output and a stopped workflow\'s status, and times out without waiting past its deadline', async () => {
    const scripted = (...responses: Array<Array<Record<string, unknown>>>) => ({
      listWorkflows: vi.fn(async () => responses.shift() ?? responses.at(-1) ?? []),
    })

    const finishing = scripted(
      [{ status: 'PENDING' }],
      [{ status: 'SUCCESS', output: { ok: true } }],
    )
    await expect(
      awaitWorkflowOutcome(finishing as never, 'wf-1', { timeoutMs: 1000, intervalMs: 1 }),
    ).resolves.toEqual({ state: 'finished', output: { ok: true } })
    expect(finishing.listWorkflows).toHaveBeenCalledTimes(2)
    expect(finishing.listWorkflows).toHaveBeenCalledWith({
      workflowIDs: ['wf-1'],
      loadInput: false,
      loadOutput: true,
    })

    await expect(
      awaitWorkflowOutcome(scripted([{ status: 'CANCELLED' }]) as never, 'wf-2', {
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({ state: 'stopped', status: 'CANCELLED' })

    await expect(
      awaitWorkflowOutcome(scripted([]) as never, 'wf-missing', { timeoutMs: 1000 }),
    ).resolves.toEqual({ state: 'stopped', status: 'MISSING' })

    // The default interval is 500 ms; the 5 ms deadline caps the wait.
    const pending = { listWorkflows: vi.fn(async () => [{ status: 'PENDING' }]) }
    const started = performance.now()
    await expect(
      awaitWorkflowOutcome(pending as never, 'wf-3', { timeoutMs: 5 }),
    ).resolves.toEqual({ state: 'timed-out' })
    expect(performance.now() - started).toBeLessThan(400)

    const aborted = new AbortController()
    const reason = new Error('The caller gave up.')
    aborted.abort(reason)
    await expect(
      awaitWorkflowOutcome(pending as never, 'wf-4', {
        timeoutMs: 1000,
        signal: aborted.signal,
      }),
    ).rejects.toBe(reason)

    // An abort while waiting between reads rejects with the same reason.
    const waiting = new AbortController()
    const later = new Error('The request closed.')
    const outcome = awaitWorkflowOutcome(pending as never, 'wf-5', {
      timeoutMs: 60_000,
      signal: waiting.signal,
    })
    setTimeout(() => waiting.abort(later), 5)
    await expect(outcome).rejects.toBe(later)
  })
})
