import { describe, expect, it, vi } from 'vitest'
import { createDevelopmentHost } from './developmentHost.js'

function middlewareModeServer() {
  return {
    config: {
      root: '/workspace/prototypes/studio',
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    },
    httpServer: undefined,
    ssrLoadModule: vi.fn(),
    watcher: { on: vi.fn() },
    environments: {
      ssr: {
        moduleGraph: {
          getModulesByFile: vi.fn(),
          onFileChange: vi.fn(),
        },
      },
    },
  }
}

describe('development host lifecycle', () => {
  it('owns one reusable composition independently of the Vite plugin adapter', async () => {
    const compose = vi.fn(async () => ({ generation: 1 }))
    const server = middlewareModeServer()

    const host = await createDevelopmentHost(server as never, compose)

    await expect(host.composition()).resolves.toEqual({ generation: 1 })
    expect(compose).toHaveBeenCalledOnce()
    expect(server.watcher.on).toHaveBeenCalledWith('change', expect.any(Function))
    expect(server.watcher.on).toHaveBeenCalledWith('unlink', expect.any(Function))
  })

  it('launches neither DBOS nor the Extraction runtime without an HTTP server of its own', async () => {
    vi.stubEnv('DATABASE_URL', undefined)
    const server = middlewareModeServer()

    try {
      await createDevelopmentHost(server as never, async () => ({}))
    } finally {
      vi.unstubAllEnvs()
    }

    expect(server.ssrLoadModule).not.toHaveBeenCalled()
  })
})
