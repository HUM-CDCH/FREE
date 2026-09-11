import { expect, it, vi } from 'vitest'
import { DEFAULT_CATALOG_POLICY } from 'extraction/catalog'
import type { ExtractionJobExecutor } from '../../../packages/extraction/src/dependencies.js'

const state = vi.hoisted(() => ({ execute: null as ExtractionJobExecutor | null, policies: [] as unknown[] }))
vi.mock('../../../packages/extraction/src/postgres-persistence.js', () => ({
  createInternalExtractionJobStore: () => ({}), createResearcherExtractionPersistence: () => ({}),
}))
vi.mock('../../../packages/extraction/src/module.js', () => ({
  createExtractionModule: vi.fn(),
  createExtractionJobExecutor: ({ policy }: { policy: unknown }) => async () => { state.policies.push(policy) },
}))
vi.mock('../../../packages/extraction/src/job-worker.js', () => ({
  ExtractionJobWorker: class { constructor(_store: unknown, execute: ExtractionJobExecutor) { state.execute = execute } },
}))

it('reads a fresh policy for each dispatched job while keeping the prior job snapshot', async () => {
  const { createExtractionRuntime } = await import('../../../packages/extraction/src/runtime.js')
  let saved = { ...DEFAULT_CATALOG_POLICY }
  const readPolicy = vi.fn(async () => saved)
  createExtractionRuntime({ models: { open: vi.fn() }, readPolicy })
  const input = {} as Parameters<ExtractionJobExecutor>[0]
  const signal = new AbortController().signal
  await state.execute!(input, null, async () => {}, signal)
  saved = { ...saved, citations: true, recordBatchSize: 9 }
  await state.execute!(input, null, async () => {}, signal)
  expect(readPolicy).toHaveBeenCalledTimes(2)
  expect(state.policies).toEqual([DEFAULT_CATALOG_POLICY, saved])
  expect(state.policies[0]).toMatchObject({ citations: false, recordBatchSize: 5 })
})
