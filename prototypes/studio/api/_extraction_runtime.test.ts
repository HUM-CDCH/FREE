import { expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ create: vi.fn(), client: vi.fn(), config: vi.fn() }))
vi.mock('extraction', async (importOriginal) => ({
  ...await importOriginal<typeof import('extraction')>(),
  createExtractionRuntime: runtime.create,
  createKeiExpClient: runtime.client,
}))
vi.mock('./_model_config.js', () => ({ readModelConfig: runtime.config }))

it('wires KEI_EXP_URL and reads only the selected model name for each extraction', async () => {
  vi.stubEnv('KEI_EXP_URL', 'http://kei-exp:8001')
  const client = { extract: vi.fn() }
  runtime.client.mockReturnValue(client)
  await import('./_extraction_runtime.js')
  expect(runtime.create).toHaveBeenCalledWith({ keiExp: client })
  const options = runtime.client.mock.calls[0][0]
  expect(options.url).toBe('http://kei-exp:8001')
  runtime.config.mockResolvedValue({ routes: { extraction: { modelId: 'selected' } } })
  expect(await options.model()).toBe('selected')
  runtime.config.mockResolvedValue({ routes: { extraction: null } })
  expect(await options.model()).toBeNull()
  vi.unstubAllEnvs()
})
