import { describe, expect, it, vi } from 'vitest'
import { createDevelopmentHost } from './developmentHost.js'

describe('development host lifecycle', () => {
  it('owns one reusable composition independently of the Vite plugin adapter', async () => {
    const compose = vi.fn(async () => ({ generation: 1 }))
    const watcher = { on: vi.fn() }
    const server = {
      config: {
        root: '/workspace/prototypes/studio',
        logger: { error: vi.fn(), info: vi.fn() },
      },
      httpServer: undefined,
      watcher,
      environments: {
        ssr: {
          moduleGraph: {
            getModulesByFile: vi.fn(),
            onFileChange: vi.fn(),
          },
        },
      },
    }

    const host = await createDevelopmentHost(server as never, compose)

    await expect(host.composition()).resolves.toEqual({ generation: 1 })
    expect(compose).toHaveBeenCalledOnce()
    expect(watcher.on).toHaveBeenCalledWith('change', expect.any(Function))
    expect(watcher.on).toHaveBeenCalledWith('unlink', expect.any(Function))
  })
})
