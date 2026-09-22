import { expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ create: vi.fn(), client: vi.fn() }))
vi.mock('extraction', async (importOriginal) => ({
  ...await importOriginal<typeof import('extraction')>(),
  createExtractionRuntime: runtime.create,
  createKeiExpClient: runtime.client,
}))

it('wires KEI_EXP_URL and names a model only when KEI_EXP_EXTRACT_MODEL does', async () => {
  vi.stubEnv('KEI_EXP_URL', 'http://kei-exp:8001')
  const client = { extract: vi.fn() }
  runtime.client.mockReturnValue(client)
  await import('./_extraction_runtime.js')
  expect(runtime.create).toHaveBeenCalledWith({ keiExp: client })
  const options = runtime.client.mock.calls[0][0]
  expect(options.url).toBe('http://kei-exp:8001')
  // Not the FREE provider route's modelId: kei-exp resolves the name against its own model
  // server, so a model id from a FREE connection means nothing there.
  expect(await options.model()).toBeNull()
  vi.stubEnv('KEI_EXP_EXTRACT_MODEL', 'a-model-on-the-kei-exp-server')
  expect(await options.model()).toBe('a-model-on-the-kei-exp-server')
  vi.unstubAllEnvs()
})
