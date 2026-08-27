import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('Vite Hono integration', () => {
  it('loads one shared application root and delegates every request to it', async () => {
    const app = {}
    const clientFallback = vi.fn(() => new Response(null))
    const createStudioApp = vi.fn(async () => app)
    const handleStudioNodeRequest = vi.fn(async () => true)
    const runtime = {
      run: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }
    const ssrLoadModule = vi.fn(async (path: string) =>
      path === '/server/app.ts'
        ? {
            createStudioApp,
            viteClientFallback: clientFallback,
            handleStudioNodeRequest,
          }
        : { extractionRuntime: runtime },
    )
    const use = vi.fn()
    const server = {
      config: {
        mode: 'development',
        root: temporaryDirectory(),
        server: { https: false },
        logger: { error: vi.fn() },
      },
      httpServer: { once: vi.fn() },
      middlewares: { use },
      ssrLoadModule,
    }
    const plugin = apiFunctions('/free')
    if (typeof plugin.configureServer !== 'function')
      throw new Error('Expected a Vite configureServer hook.')

    await plugin.configureServer(server as never)
    expect(ssrLoadModule).toHaveBeenCalledWith('/api/_extraction_runtime.ts')
    expect(ssrLoadModule).toHaveBeenCalledWith('/server/app.ts')
    expect(createStudioApp).toHaveBeenCalledWith(expect.objectContaining({
      studioOrigin: 'http://127.0.0.1:5173',
      basePath: '/free',
      sessionSecret: expect.any(Uint8Array),
      identityProvider: expect.objectContaining({
        authorizationUrl: expect.any(Function),
        redeemAuthorizationCode: expect.any(Function),
        logoutUrl: expect.any(Function),
      }),
      accountStore: undefined,
      playwrightAuthentication: undefined,
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
    ).resolves.toContain('/free/auth/callback?')
    expect(use).toHaveBeenCalledTimes(1)

    const middleware = use.mock.calls[0][0] as (
      request: IncomingMessage,
      response: ServerResponse,
      next: (error?: Error) => void,
    ) => Promise<void>
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

  it('uses real Entra only after explicit HTTPS opt-in', async () => {
    vi.stubEnv('FREE_ENTRA_REAL', '1')
    const createStudioApp = vi.fn()
    const plugin = apiFunctions('/')
    if (typeof plugin.configureServer !== 'function')
      throw new Error('Expected a Vite configureServer hook.')

    await expect(
      plugin.configureServer({
        config: {
          mode: 'development',
          root: temporaryDirectory(),
          server: { https: false },
          logger: { error: vi.fn() },
        },
        middlewares: { use: vi.fn() },
        ssrLoadModule: vi.fn(async () => ({
          createStudioApp,
          viteClientFallback: vi.fn(),
          handleStudioNodeRequest: vi.fn(),
        })),
      } as never),
    ).rejects.toThrow('Real Entra development requires an HTTPS Studio origin.')
    expect(createStudioApp).not.toHaveBeenCalled()
  })

  it('keeps Playwright on fake Entra despite inherited real-Entra state', async () => {
    vi.stubEnv('FREE_ENTRA_REAL', '1')
    vi.stubEnv('FREE_PLAYWRIGHT_AUTH', '1')
    const createStudioApp = vi.fn(async () => ({}))
    const runtime = {
      run: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }
    const plugin = apiFunctions('/')
    if (typeof plugin.configureServer !== 'function')
      throw new Error('Expected a Vite configureServer hook.')

    await expect(
      plugin.configureServer({
        config: {
          mode: 'development',
          root: temporaryDirectory(),
          server: { https: false, host: '127.0.0.1' },
          logger: { error: vi.fn() },
        },
        httpServer: { once: vi.fn() },
        middlewares: { use: vi.fn() },
        ssrLoadModule: vi.fn(async (path: string) =>
          path === '/api/_extraction_runtime.ts'
            ? { extractionRuntime: runtime }
            : {
                createStudioApp,
                viteClientFallback: vi.fn(),
                handleStudioNodeRequest: vi.fn(),
              },
        ),
      } as never),
    ).resolves.toBeUndefined()
    expect(createStudioApp).toHaveBeenCalledWith(
      expect.objectContaining({
        accountStore: expect.objectContaining({
          findOrCreate: expect.any(Function),
          findById: expect.any(Function),
        }),
        playwrightAuthentication: expect.any(Function),
      }),
    )
  })

  it('rejects Playwright authentication on a wildcard Vite listener', async () => {
    vi.stubEnv('FREE_PLAYWRIGHT_AUTH', '1')
    const createStudioApp = vi.fn(async () => ({}))
    const runtime = {
      run: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }
    const plugin = apiFunctions('/')
    if (typeof plugin.configureServer !== 'function')
      throw new Error('Expected a Vite configureServer hook.')

    await expect(
      plugin.configureServer({
        config: {
          mode: 'https',
          root: temporaryDirectory(),
          server: { https: true, host: '0.0.0.0' },
          logger: { error: vi.fn() },
        },
        httpServer: { once: vi.fn() },
        middlewares: { use: vi.fn() },
        ssrLoadModule: vi.fn(async (path: string) =>
          path === '/api/_extraction_runtime.ts'
            ? { extractionRuntime: runtime }
            : {
                createStudioApp,
                viteClientFallback: vi.fn(),
                handleStudioNodeRequest: vi.fn(),
              },
        ),
      } as never),
    ).rejects.toThrow(
      'Playwright authentication requires Vite to listen on 127.0.0.1.',
    )
    expect(runtime.run).not.toHaveBeenCalled()
    expect(createStudioApp).not.toHaveBeenCalled()
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

    expect(config.server).toEqual({ host: '127.0.0.1' })
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
