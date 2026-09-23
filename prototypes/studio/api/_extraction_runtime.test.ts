import { expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ create: vi.fn(), client: vi.fn() }))
vi.mock('extraction', async (importOriginal) => ({
  ...await importOriginal<typeof import('extraction')>(),
  createExtractionRuntime: runtime.create,
  createKeiExpClient: runtime.client,
}))

it('wires KEI_EXP_URL and names no deployment-wide model: each run chooses its own, or kei-exp\'s defaults apply', async () => {
  vi.stubEnv('KEI_EXP_URL', 'http://kei-exp:8001')
  const client = { extract: vi.fn(), listModels: vi.fn() }
  runtime.client.mockReturnValue(client)
  const module = await import('./_extraction_runtime.js')
  expect(runtime.create).toHaveBeenCalledWith({ keiExp: client })
  expect(module.keiExpClient).toBe(client)
  // Only the endpoint: neither a FREE connection's model id nor any env model reaches kei-exp.
  expect(runtime.client.mock.calls[0][0]).toEqual({ url: 'http://kei-exp:8001' })
  vi.unstubAllEnvs()
})
