import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import studioConfig, {
  apiFunctions,
  developmentStudioOrigin,
  localHttps,
} from './vite.config.js'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'free-studio-vite-'))
  temporaryDirectories.push(directory)
  return directory
}

// The composition consults process.env before any .env file, so a shell that
// exported the repository .env would otherwise steer these tests.
const AMBIENT_STUDIO_ENVIRONMENT = [
  'STUDIO_ORIGIN',
  'STUDIO_BASE_PATH',
  'FREE_SESSION_SECRET',
  'FREE_ENTRA_REAL',
  'FREE_ENTRA_MOCK_BROWSER_ISSUER',
]

beforeEach(() => {
  for (const name of AMBIENT_STUDIO_ENVIRONMENT) vi.stubEnv(name, undefined)
  vi.stubEnv('FREE_ENTRA_MOCK_ISSUER', 'http://mock-oidc:8080/dev')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

// One fake Vite development server: the SSR loader under test, the watcher it
// subscribes to, and the SSR module graph that decides whether a changed file
// is server code.
function developmentServer(options: {
  mode?: string
  server?: Record<string, unknown>
  httpServer?: boolean
  ssrLoadModule: (path: string) => Promise<Record<string, unknown>>
}) {
  const watched = new Map<string, (file: string) => void>()
  const serverModules = new Set<string>()
  const onFileChange = vi.fn()
  const use = vi.fn()
  const logger = { error: vi.fn(), info: vi.fn() }
  const ssrLoadModule = vi.fn(options.ssrLoadModule)
  return {
    serverModules,
    onFileChange,
    ssrLoadModule,
    logger,
    change: (file: string) => watched.get('change')?.(file),
    middleware: () =>
      use.mock.calls[0]![0] as (
        request: IncomingMessage,
        response: ServerResponse,
        next: (error?: Error) => void,
      ) => Promise<void>,
    server: {
      config: {
        mode: options.mode ?? 'development',
        root: temporaryDirectory(),
        server: options.server ?? { https: false },
        logger,
      },
      httpServer: options.httpServer === false ? undefined : { once: vi.fn() },
      middlewares: { use },
      ssrLoadModule,
      watcher: {
        on: (event: string, listener: (file: string) => void) => {
          watched.set(event, listener)
        },
      },
      environments: {
        ssr: {
          moduleGraph: {
            getModulesByFile: (file: string) =>
              serverModules.has(file) ? new Set([{ file }]) : undefined,
            onFileChange,
          },
        },
      },
    } as never,
  }
}

function studioModules(parts: {
  createStudioApp: (options: Record<string, unknown>) => Promise<unknown>
  viteClientFallback?: () => Response
  handleStudioNodeRequest?: () => Promise<boolean>
  extractionRuntime?: unknown
}) {
  return async (path: string) =>
    path === '/api/_extraction_runtime.ts'
      ? {
          extractionRuntime:
            parts.extractionRuntime ?? {
              run: vi.fn(async () => undefined),
              close: vi.fn(async () => undefined),
            },
        }
      : {
          createStudioApp: parts.createStudioApp,
          viteClientFallback: parts.viteClientFallback ?? vi.fn(),
          handleStudioNodeRequest: parts.handleStudioNodeRequest ?? vi.fn(),
        }
}

function configureServerHook(plugin: Plugin) {
  if (typeof plugin.configureServer !== 'function')
    throw new Error('Expected a Vite configureServer hook.')
  return plugin.configureServer
}

describe('Vite Hono integration', () => {
  it.each([
    {
      reason: 'noncanonical base64',
      value: Buffer.alloc(32, 11).toString('base64').slice(0, -1),
      error: /canonical base64/,
    },
    {
      reason: 'a decoded value below 32 bytes',
      value: Buffer.alloc(31, 11).toString('base64'),
      error: /at least 32 bytes/,
    },
  ])(
    'rejects a configured session secret with $reason',
    async ({ value, error }) => {
      vi.stubEnv('FREE_SESSION_SECRET', value)
      const createStudioApp = vi.fn(async () => ({}))
      const development = developmentServer({
        ssrLoadModule: studioModules({ createStudioApp }),
      })

      await expect(
        configureServerHook(apiFunctions('/'))(development.server),
      ).rejects.toThrow(error)
      expect(createStudioApp).not.toHaveBeenCalled()
    },
  )

  it.each([32, 33])(
    'accepts a configured session secret of %i bytes',
    async (byteLength) => {
      const secret = Buffer.alloc(byteLength, 11)
      vi.stubEnv('FREE_SESSION_SECRET', secret.toString('base64'))
      const createStudioApp = vi.fn(async () => ({}))
      const development = developmentServer({
        ssrLoadModule: studioModules({ createStudioApp }),
      })

      await configureServerHook(apiFunctions('/'))(development.server)

      expect(createStudioApp).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionSecret: new Uint8Array(secret),
        }),
      )
    },
  )

  it('loads one shared application root and delegates every request to it', async () => {
    const app = {}
    const clientFallback = vi.fn(() => new Response(null))
    const createStudioApp = vi.fn(async () => app)
    const handleStudioNodeRequest = vi.fn(async () => true)
    const runtime = {
      run: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }
    const development = developmentServer({
      ssrLoadModule: studioModules({
        createStudioApp,
        viteClientFallback: clientFallback,
        handleStudioNodeRequest,
        extractionRuntime: runtime,
      }),
    })
    const plugin = apiFunctions('/free')

    await configureServerHook(plugin)(development.server)
    expect(development.ssrLoadModule).toHaveBeenCalledWith(
      '/api/_extraction_runtime.ts',
    )
    expect(development.ssrLoadModule).toHaveBeenCalledWith('/server/app.ts')
    expect(createStudioApp).toHaveBeenCalledWith(expect.objectContaining({
      studioOrigin: 'http://127.0.0.1:5173',
      basePath: '/free',
      sessionSecret: expect.any(Uint8Array),
      identityProvider: expect.objectContaining({
        authorizationUrl: expect.any(Function),
        redeemAuthorizationCode: expect.any(Function),
        logoutUrl: expect.any(Function),
      }),
      clientHandler: clientFallback,
      viteDevelopmentAssets: true,
    }))
    const identityProvider = createStudioApp.mock.calls[0][0]
      .identityProvider as {
        authorizationUrl(input: {
          redirectUri: string
          state: string
          nonce: string
          codeChallenge: string
        }): Promise<string>
      }
    await expect(
      identityProvider.authorizationUrl({
        redirectUri: 'http://127.0.0.1:5173/free/auth/callback',
        state: 'state',
        nonce: 'nonce',
        codeChallenge: 'challenge',
      }),
    ).resolves.toMatch(/^http:\/\/mock-oidc:8080\/dev\/authorize\?/)

    const middleware = development.middleware()
    const request = {} as IncomingMessage
    const response = {} as ServerResponse
    const next = vi.fn()
    await middleware(request, response, next)
    expect(handleStudioNodeRequest).toHaveBeenCalledWith(
      app,
      'http://127.0.0.1:5173',
      request,
      response,
    )
    expect(next).not.toHaveBeenCalled()

    handleStudioNodeRequest.mockResolvedValueOnce(false)
    await middleware(request, response, next)
    expect(next).toHaveBeenCalledOnce()
  })

  it('recomposes the application when a loaded server module changes', async () => {
    vi.useFakeTimers()
    const apps = [{ generation: 1 }, { generation: 2 }]
    const createStudioApp = vi.fn(async () => apps[createStudioApp.mock.calls.length - 1])
    const handleStudioNodeRequest = vi.fn(async () => true)
    const runtime = {
      run: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }
    const development = developmentServer({
      ssrLoadModule: studioModules({
        createStudioApp,
        handleStudioNodeRequest,
        extractionRuntime: runtime,
      }),
    })
    development.serverModules.add('/workspace/prototypes/studio/server/app.ts')
    const plugin = apiFunctions('/free')

    await configureServerHook(plugin)(development.server)
    expect(createStudioApp).toHaveBeenCalledOnce()

    // A client module is not part of the server graph, so it recomposes nothing.
    development.change('/workspace/prototypes/studio/src/App.tsx')
    await vi.advanceTimersByTimeAsync(100)
    expect(createStudioApp).toHaveBeenCalledOnce()
    expect(development.onFileChange).not.toHaveBeenCalled()

    development.change('/workspace/prototypes/studio/server/app.ts')
    await vi.advanceTimersByTimeAsync(100)
    expect(development.onFileChange).toHaveBeenCalledWith(
      '/workspace/prototypes/studio/server/app.ts',
    )
    expect(createStudioApp).toHaveBeenCalledTimes(2)
    expect(development.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('server reloaded'),
      { timestamp: true },
    )

    // The recomposed application, not the replaced one, serves the next request.
    const next = vi.fn()
    await development.middleware()(
      {} as IncomingMessage,
      {} as ServerResponse,
      next,
    )
    expect(handleStudioNodeRequest).toHaveBeenCalledWith(
      apps[1],
      'http://127.0.0.1:5173',
      expect.anything(),
      expect.anything(),
    )
    expect(createStudioApp).toHaveBeenCalledTimes(2)
    // The Extraction runtime module was not re-evaluated, so the worker that
    // was already running keeps running.
    expect(runtime.run).toHaveBeenCalledOnce()
    expect(runtime.close).not.toHaveBeenCalled()
  })

  it('stops the running Extraction runtime a reload replaced', async () => {
    vi.useFakeTimers()
    const replaced = {
      run: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }
    const adopted = {
      run: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }
    let extractionRuntime: unknown = replaced
    const development = developmentServer({
      ssrLoadModule: async (path: string) =>
        path === '/api/_extraction_runtime.ts'
          ? { extractionRuntime }
          : {
              createStudioApp: vi.fn(async () => ({})),
              viteClientFallback: vi.fn(),
              handleStudioNodeRequest: vi.fn(),
            },
    })
    development.serverModules.add('/workspace/prototypes/studio/api/_model.ts')
    const plugin = apiFunctions('/free')

    await configureServerHook(plugin)(development.server)
    expect(replaced.run).toHaveBeenCalledOnce()

    extractionRuntime = adopted
    development.change('/workspace/prototypes/studio/api/_model.ts')
    await vi.advanceTimersByTimeAsync(100)

    expect(replaced.close).toHaveBeenCalledOnce()
    expect(replaced.run.mock.calls[0]![0]!.aborted).toBe(true)
    expect(adopted.run).toHaveBeenCalledOnce()
    expect(adopted.close).not.toHaveBeenCalled()
  })

  it('recomposes after a server module fails to evaluate', async () => {
    vi.useFakeTimers()
    const createStudioApp = vi.fn(async () => ({}))
    let broken = false
    const development = developmentServer({
      ssrLoadModule: async (path: string) => {
        if (path === '/api/_extraction_runtime.ts')
          return {
            extractionRuntime: {
              run: vi.fn(async () => undefined),
              close: vi.fn(async () => undefined),
            },
          }
        if (broken) throw new Error('Unexpected token')
        return {
          createStudioApp,
          viteClientFallback: vi.fn(),
          handleStudioNodeRequest: vi.fn(async () => true),
        }
      },
    })
    development.serverModules.add('/workspace/prototypes/studio/server/app.ts')
    const plugin = apiFunctions('/free')

    await configureServerHook(plugin)(development.server)

    broken = true
    development.change('/workspace/prototypes/studio/server/app.ts')
    await vi.advanceTimersByTimeAsync(100)
    expect(development.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Unexpected token'),
    )
    const next = vi.fn()
    await development.middleware()(
      {} as IncomingMessage,
      {} as ServerResponse,
      next,
    )
    expect(next).toHaveBeenCalledWith(expect.any(Error))

    broken = false
    development.change('/workspace/prototypes/studio/server/app.ts')
    await vi.advanceTimersByTimeAsync(100)
    const recomposed = vi.fn()
    await development.middleware()(
      {} as IncomingMessage,
      {} as ServerResponse,
      recomposed,
    )
    expect(recomposed).not.toHaveBeenCalled()
  })

  it('reports a failing watcher change instead of taking the server down', async () => {
    const development = developmentServer({
      ssrLoadModule: studioModules({ createStudioApp: vi.fn(async () => ({})) }),
    })
    development.serverModules.add('/workspace/prototypes/studio/server/app.ts')
    development.onFileChange.mockImplementation(() => {
      throw new Error('module graph unavailable')
    })
    const plugin = apiFunctions('/free')

    await configureServerHook(plugin)(development.server)

    expect(() =>
      development.change('/workspace/prototypes/studio/server/app.ts'),
    ).not.toThrow()
    expect(development.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('module graph unavailable'),
    )
  })

  it('uses real Entra only after explicit HTTPS opt-in', async () => {
    vi.stubEnv('FREE_ENTRA_REAL', '1')
    const createStudioApp = vi.fn()
    const development = developmentServer({
      httpServer: false,
      ssrLoadModule: studioModules({ createStudioApp }),
    })
    const plugin = apiFunctions('/')

    await expect(
      configureServerHook(plugin)(development.server),
    ).rejects.toThrow('Real Entra development requires an HTTPS Studio origin.')
    expect(createStudioApp).not.toHaveBeenCalled()
  })

  it('requires a mock OIDC issuer when real Entra is not selected', async () => {
    vi.stubEnv('FREE_ENTRA_MOCK_ISSUER', '')
    const createStudioApp = vi.fn(async () => ({}))
    const development = developmentServer({
      ssrLoadModule: studioModules({ createStudioApp }),
    })
    const plugin = apiFunctions('/')

    await expect(
      configureServerHook(plugin)(development.server),
    ).rejects.toThrow(
      'FREE_ENTRA_MOCK_ISSUER is required for development sign-in.',
    )
    expect(createStudioApp).not.toHaveBeenCalled()
  })

  it('drives development sign-in through the mock OIDC issuer when configured', async () => {
    vi.stubEnv('FREE_ENTRA_MOCK_ISSUER', 'http://mock-oidc:8080/dev')
    vi.stubEnv('FREE_ENTRA_MOCK_BROWSER_ISSUER', 'http://localhost:8444/dev')
    const createStudioApp = vi.fn(async () => ({}))
    const development = developmentServer({
      ssrLoadModule: studioModules({ createStudioApp }),
    })
    const plugin = apiFunctions('/free')

    await configureServerHook(plugin)(development.server)

    const identityProvider = createStudioApp.mock.calls[0]![0]!
      .identityProvider as {
        authorizationUrl(input: {
          redirectUri: string
          state: string
          nonce: string
          codeChallenge: string
        }): Promise<string>
        logoutUrl(postLogoutRedirectUri: string): string
      }
    await expect(
      identityProvider.authorizationUrl({
        redirectUri: 'https://localhost:8443/free/auth/callback',
        state: 'state',
        nonce: 'nonce',
        codeChallenge: 'challenge',
      }),
    ).resolves.toMatch(/^http:\/\/localhost:8444\/dev\/authorize\?/)
    expect(
      identityProvider.logoutUrl(
        'https://localhost:8443/free/auth/signed-out',
      ),
    ).toMatch(/^http:\/\/localhost:8444\/dev\/endsession\?/)
  })

})

describe('Vite HTTPS mode', () => {
  it('fails clearly when certificate files are missing', () => {
    expect(() => localHttps(temporaryDirectory())).toThrowError(
      /HTTPS mode requires readable certificate files.*mkcert.*for HTTP/,
    )
  })

  it('fails clearly when a certificate file is unreadable', () => {
    const certificates = temporaryDirectory()
    writeFileSync(join(certificates, 'studio.pem'), 'certificate')
    mkdirSync(join(certificates, 'studio-key.pem'))

    expect(() => localHttps(certificates)).toThrowError(
      /HTTPS mode requires readable certificate files.*mkcert.*for HTTP/,
    )
  })

  it('loads existing certificate files', () => {
    const certificates = temporaryDirectory()
    writeFileSync(join(certificates, 'studio.pem'), 'certificate')
    writeFileSync(join(certificates, 'studio-key.pem'), 'key')

    expect(localHttps(certificates)).toEqual({
      https: {
        cert: Buffer.from('certificate'),
        key: Buffer.from('key'),
      },
    })
  })

  it('derives the exact configured port and localhost HTTPS origin', () => {
    expect(
      developmentStudioOrigin({
        https: false,
        host: '127.0.0.1',
        port: 41739,
      }),
    ).toBe('http://127.0.0.1:41739')
    expect(
      developmentStudioOrigin({
        https: true,
        host: '0.0.0.0',
        port: 5173,
      }),
    ).toBe('https://localhost:5173')
  })

  it('leaves ordinary development mode on HTTP', async () => {
    const config = await studioConfig({
      command: 'serve',
      mode: 'development',
      isSsrBuild: false,
      isPreview: false,
    })

    expect(config.server).toEqual({
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    })
  })

  it('serves a configured path prefix and keeps production assets relocatable', async () => {
    vi.stubEnv('STUDIO_BASE_PATH', '/free')
    const development = await studioConfig({
      command: 'serve',
      mode: 'development',
      isSsrBuild: false,
      isPreview: false,
    })
    const production = await studioConfig({
      command: 'build',
      mode: 'production',
      isSsrBuild: false,
      isPreview: false,
    })

    expect(development.base).toBe('/free/')
    expect(production.base).toBe('./')
  })
})
