import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import studioConfig, {
  apiFunctions,
  developmentStudioOrigin,
  localHttps,
  pdfjsWasmAssets,
} from './vite.config.js'

const temporaryDirectories: string[] = []

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, cpSync: vi.fn(fs.cpSync), renameSync: vi.fn(fs.renameSync) }
})

it.each(['serve', 'build'] as const)('resolves %s config without copying assets', async (command) => {
  vi.stubEnv('VITEST', undefined)
  vi.mocked(cpSync).mockClear()
  await studioConfig({ command, mode: 'development' })
  expect(cpSync).not.toHaveBeenCalled()
})

describe('PDF.js assets', () => {
  function fixture() {
    const root = temporaryDirectory()
    const source = join(root, 'node_modules/pdfjs-dist/wasm')
    const destination = join(root, 'public/assets/pdfjs-wasm')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'decoder.wasm'), 'decoder')
    return { root, source, destination }
  }

  it('copies at server startup and leaves existing assets untouched', () => {
    const { root, destination } = fixture()
    const prepare = configureServerHook(pdfjsWasmAssets('serve', root))
    expect(existsSync(destination)).toBe(false)
    prepare({} as never)
    expect(readFileSync(join(destination, 'decoder.wasm'), 'utf8')).toBe('decoder')
    vi.mocked(cpSync).mockClear()
    prepare({} as never)
    expect(cpSync).not.toHaveBeenCalled()
  })

  it('copies at build start', async () => {
    const { root, destination } = fixture()
    const hook = pdfjsWasmAssets('build', root).buildStart
    if (typeof hook !== 'function') throw new Error('Expected buildStart hook')
    await hook.call({} as never, {} as never)
    expect(readFileSync(join(destination, 'decoder.wasm'), 'utf8')).toBe('decoder')
  })

  it('does not write when the install is missing', () => {
    const root = temporaryDirectory()
    configureServerHook(pdfjsWasmAssets('serve', root))({} as never)
    expect(readdirSync(root)).toEqual([])
  })

  it('accepts another process publishing first and removes its temporary copy', () => {
    const { root, source, destination } = fixture()
    vi.mocked(renameSync).mockImplementationOnce(() => {
      cpSync(source, destination, { recursive: true })
      throw Object.assign(new Error('Already published'), { code: 'EEXIST' })
    })
    configureServerHook(pdfjsWasmAssets('serve', root))({} as never)
    expect(readdirSync(join(root, 'public/assets'))).toEqual(['pdfjs-wasm'])
    expect(readFileSync(join(destination, 'decoder.wasm'), 'utf8')).toBe('decoder')
  })

  it('propagates copy failures without publishing partial assets', () => {
    const { root, destination } = fixture()
    vi.mocked(cpSync).mockImplementationOnce(() => { throw new Error('Copy failed') })
    expect(() => configureServerHook(pdfjsWasmAssets('serve', root))({} as never)).toThrow('Copy failed')
    expect(existsSync(destination)).toBe(false)
    expect(readdirSync(join(root, 'public/assets'))).toEqual([])
  })

  it('omits asset preparation under Vitest', async () => {
    vi.stubEnv('VITEST', 'true')
    const config = await studioConfig({ command: 'serve', mode: 'test' })
    expect(config.plugins).not.toContainEqual(expect.objectContaining({ name: 'free-pdfjs-wasm' }))
  })
})

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

// A synthetic URL: the stubbed DBOS module never connects to it.
const DEVELOPMENT_DATABASE_URL =
  'postgresql://postgres@127.0.0.1:5432/free_test_development_host'

beforeEach(() => {
  for (const name of AMBIENT_STUDIO_ENVIRONMENT) vi.stubEnv(name, undefined)
  vi.stubEnv('FREE_ENTRA_MOCK_ISSUER', 'http://mock-oidc:8080/dev')
  vi.stubEnv('DATABASE_URL', DEVELOPMENT_DATABASE_URL)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

type StudioDbosModule = {
  launchStudioDbos: ReturnType<typeof vi.fn>
  shutdownStudioDbos: ReturnType<typeof vi.fn>
}

function studioDbosModule(): StudioDbosModule {
  return {
    launchStudioDbos: vi.fn(async () => ({})),
    shutdownStudioDbos: vi.fn(async () => undefined),
  }
}

// One fake Vite development server: the SSR loader under test, the watcher it
// subscribes to, and the SSR module graph that decides whether a changed file
// is server code. It serves the DBOS modules itself, so every composition runs
// after a (stubbed) launch as it does in development.
function developmentServer(options: {
  mode?: string
  server?: Record<string, unknown>
  httpServer?: boolean
  dbos?: StudioDbosModule
  ssrLoadModule: (path: string) => Promise<Record<string, unknown>>
}) {
  const watched = new Map<string, (file: string) => void>()
  const httpServerListeners = new Map<string, () => void>()
  const serverModules = new Set<string>()
  const onFileChange = vi.fn()
  const use = vi.fn()
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() }
  const dbos = options.dbos ?? studioDbosModule()
  const workflows = { registerStudioWorkflows: vi.fn(), applyStudioSchedules: vi.fn(async () => undefined) }
  const ssrLoadModule = vi.fn(async (path: string) => {
    if (path === '/server/dbos.ts') return dbos
    if (path === '/server/workflows.ts') return workflows
    return options.ssrLoadModule(path)
  })
  return {
    serverModules,
    onFileChange,
    ssrLoadModule,
    logger,
    dbos,
    workflows,
    loaded: (path: string) =>
      ssrLoadModule.mock.calls.filter(([loaded]) => loaded === path).length,
    change: (file: string) => watched.get('change')?.(file),
    closeHttpServer: () => httpServerListeners.get('close')?.(),
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
      httpServer:
        options.httpServer === false
          ? undefined
          : {
              once: (event: string, listener: () => void) => {
                httpServerListeners.set(event, listener)
              },
            },
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
}) {
  return async () => ({
    createStudioApp: parts.createStudioApp,
    viteClientFallback: parts.viteClientFallback ?? vi.fn(),
    handleStudioNodeRequest: parts.handleStudioNodeRequest ?? vi.fn(),
  })
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

  it('loads /server/dbos.ts and /server/workflows.ts once and launches DBOS before the first composition', async () => {
    const order: string[] = []
    const dbos = studioDbosModule()
    dbos.launchStudioDbos.mockImplementation(async () => {
      await Promise.resolve()
      order.push('dbos launched')
      return {}
    })
    const createStudioApp = vi.fn(async () => {
      order.push('composed')
      return {}
    })
    const development = developmentServer({
      dbos,
      ssrLoadModule: studioModules({ createStudioApp }),
    })

    await configureServerHook(apiFunctions('/free'))(development.server)
    await development.middleware()(
      {} as IncomingMessage,
      {} as ServerResponse,
      vi.fn(),
    )

    expect(development.loaded('/server/dbos.ts')).toBe(1)
    expect(development.loaded('/server/workflows.ts')).toBe(1)
    expect(dbos.launchStudioDbos).toHaveBeenCalledOnce()
    const [launch] = dbos.launchStudioDbos.mock.calls[0]!
    expect(launch).toEqual({
      databaseUrl: DEVELOPMENT_DATABASE_URL,
      register: expect.any(Function),
      schedule: expect.any(Function),
    })
    expect(launch.register).toBe(
      development.workflows.registerStudioWorkflows,
    )
    expect(launch.schedule).toBe(development.workflows.applyStudioSchedules)
    expect(order).toEqual(['dbos launched', 'composed'])
  })

  it('loads one shared application root and delegates every request to it', async () => {
    const app = {}
    const clientFallback = vi.fn(() => new Response(null))
    const createStudioApp = vi.fn(async () => app)
    const handleStudioNodeRequest = vi.fn(async () => true)
    const development = developmentServer({
      ssrLoadModule: studioModules({
        createStudioApp,
        viteClientFallback: clientFallback,
        handleStudioNodeRequest,
      }),
    })
    const plugin = apiFunctions('/free')

    await configureServerHook(plugin)(development.server)
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

  it('recomposes the application after a server module changes without launching DBOS again', async () => {
    vi.useFakeTimers()
    const apps = [{ generation: 1 }, { generation: 2 }]
    const createStudioApp = vi.fn(async () => apps[createStudioApp.mock.calls.length - 1])
    const handleStudioNodeRequest = vi.fn(async () => true)
    const development = developmentServer({
      ssrLoadModule: studioModules({
        createStudioApp,
        handleStudioNodeRequest,
      }),
    })
    development.serverModules.add('/workspace/apps/studio/server/app.ts')
    const plugin = apiFunctions('/free')

    await configureServerHook(plugin)(development.server)
    expect(createStudioApp).toHaveBeenCalledOnce()

    // A client module is not part of the server graph, so it recomposes nothing.
    development.change('/workspace/apps/studio/src/App.tsx')
    await vi.advanceTimersByTimeAsync(100)
    expect(createStudioApp).toHaveBeenCalledOnce()
    expect(development.onFileChange).not.toHaveBeenCalled()

    development.change('/workspace/apps/studio/server/app.ts')
    await vi.advanceTimersByTimeAsync(100)
    expect(development.onFileChange).toHaveBeenCalledWith(
      '/workspace/apps/studio/server/app.ts',
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
    // DBOS launches once per process: recomposition re-evaluates handlers only.
    expect(development.loaded('/server/dbos.ts')).toBe(1)
    expect(development.loaded('/server/workflows.ts')).toBe(1)
    expect(development.dbos.launchStudioDbos).toHaveBeenCalledOnce()
    expect(development.dbos.shutdownStudioDbos).not.toHaveBeenCalled()
    expect(development.logger.warn).not.toHaveBeenCalled()
  })

  it('logs a restart hint once when a workflow module changes', async () => {
    vi.useFakeTimers()
    const createStudioApp = vi.fn(async () => ({}))
    const development = developmentServer({
      ssrLoadModule: studioModules({ createStudioApp }),
    })
    const workflowModule =
      '/workspace/apps/studio/api/_ingestion_workflow.ts'
    development.serverModules.add(workflowModule)
    development.serverModules.add('/workspace/apps/studio/server/app.ts')

    await configureServerHook(apiFunctions('/free'))(development.server)
    development.change(workflowModule)
    await vi.advanceTimersByTimeAsync(100)

    expect(development.logger.warn).toHaveBeenCalledOnce()
    expect(development.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('restart Studio'),
    )
    // The handlers still recompose; only the registered workflow code is stale.
    expect(createStudioApp).toHaveBeenCalledTimes(2)

    development.change('/workspace/apps/studio/server/app.ts')
    await vi.advanceTimersByTimeAsync(100)
    expect(development.logger.warn).toHaveBeenCalledOnce()
    expect(development.dbos.launchStudioDbos).toHaveBeenCalledOnce()

    // The running DBOS keeps the configuration and queues it launched with.
    const dbosModule = '/workspace/apps/studio/server/dbos.ts'
    development.serverModules.add(dbosModule)
    development.change(dbosModule)
    await vi.advanceTimersByTimeAsync(100)
    expect(development.logger.warn).toHaveBeenCalledTimes(2)
    expect(development.logger.warn).toHaveBeenLastCalledWith(
      expect.stringContaining('restart Studio'),
    )

    // runExtraction was registered with the ports this module built.
    const portsModule = '/workspace/apps/studio/api/_extractions.ts'
    development.serverModules.add(portsModule)
    development.change(portsModule)
    await vi.advanceTimersByTimeAsync(100)
    expect(development.logger.warn).toHaveBeenCalledTimes(3)
  })

  it('a restarted dev server adopts the running DBOS, and closing the server it replaced leaves DBOS running', async () => {
    // Vite restarts by configuring the new server before it closes the old one.
    const dbos = studioDbosModule()
    const replaced = developmentServer({
      dbos,
      ssrLoadModule: studioModules({ createStudioApp: vi.fn(async () => ({})) }),
    })
    await configureServerHook(apiFunctions('/free'))(replaced.server)
    const restarted = developmentServer({
      dbos,
      ssrLoadModule: studioModules({ createStudioApp: vi.fn(async () => ({})) }),
    })
    await configureServerHook(apiFunctions('/free'))(restarted.server)

    replaced.closeHttpServer()
    await new Promise((resolve) => setImmediate(resolve))
    expect(dbos.shutdownStudioDbos).not.toHaveBeenCalled()

    restarted.closeHttpServer()
    await vi.waitFor(() =>
      expect(dbos.shutdownStudioDbos).toHaveBeenCalledOnce(),
    )
  })

  it('a restart that fails to configure leaves DBOS to the server that keeps running', async () => {
    const dbos = studioDbosModule()
    const running = developmentServer({
      dbos,
      ssrLoadModule: studioModules({ createStudioApp: vi.fn(async () => ({})) }),
    })
    await configureServerHook(apiFunctions('/free'))(running.server)
    const failed = developmentServer({
      dbos,
      ssrLoadModule: studioModules({
        createStudioApp: vi.fn(async () => {
          throw new Error('Unexpected token')
        }),
      }),
    })
    await expect(
      configureServerHook(apiFunctions('/free'))(failed.server),
    ).rejects.toThrow('Unexpected token')

    running.closeHttpServer()
    await vi.waitFor(() =>
      expect(dbos.shutdownStudioDbos).toHaveBeenCalledOnce(),
    )
  })

  it('shuts DBOS down when the HTTP server closes', async () => {
    const development = developmentServer({
      ssrLoadModule: studioModules({ createStudioApp: vi.fn(async () => ({})) }),
    })

    await configureServerHook(apiFunctions('/free'))(development.server)
    expect(development.dbos.shutdownStudioDbos).not.toHaveBeenCalled()
    development.closeHttpServer()

    await vi.waitFor(() =>
      expect(development.dbos.shutdownStudioDbos).toHaveBeenCalledOnce(),
    )
    expect(development.logger.error).not.toHaveBeenCalled()
  })

  it('fails startup when DATABASE_URL does not name Studio\'s database', async () => {
    vi.stubEnv('DATABASE_URL', undefined)
    const createStudioApp = vi.fn(async () => ({}))
    const development = developmentServer({
      ssrLoadModule: studioModules({ createStudioApp }),
    })

    await expect(
      configureServerHook(apiFunctions('/free'))(development.server),
    ).rejects.toThrow("DATABASE_URL must name Studio's database.")
    expect(development.dbos.launchStudioDbos).not.toHaveBeenCalled()
    expect(createStudioApp).not.toHaveBeenCalled()
  })

  it('recomposes after a server module fails to evaluate', async () => {
    vi.useFakeTimers()
    const createStudioApp = vi.fn(async () => ({}))
    let broken = false
    const development = developmentServer({
      ssrLoadModule: async () => {
        if (broken) throw new Error('Unexpected token')
        return {
          createStudioApp,
          viteClientFallback: vi.fn(),
          handleStudioNodeRequest: vi.fn(async () => true),
        }
      },
    })
    development.serverModules.add('/workspace/apps/studio/server/app.ts')
    const plugin = apiFunctions('/free')

    await configureServerHook(plugin)(development.server)

    broken = true
    development.change('/workspace/apps/studio/server/app.ts')
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
    development.change('/workspace/apps/studio/server/app.ts')
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
    development.serverModules.add('/workspace/apps/studio/server/app.ts')
    development.onFileChange.mockImplementation(() => {
      throw new Error('module graph unavailable')
    })
    const plugin = apiFunctions('/free')

    await configureServerHook(plugin)(development.server)

    expect(() =>
      development.change('/workspace/apps/studio/server/app.ts'),
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
