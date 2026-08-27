import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { ServerType } from '@hono/node-server'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadStudioServerConfig } from './config.js'
import { createFakeEntraIdentityProvider } from './entraIdentityProvider.js'
import {
  startStudioServer,
  type StudioRuntime,
  type StudioSignalTarget,
} from './host.js'

const SECRET = Buffer.alloc(32, 13).toString('base64')
const roots: string[] = []

async function clientRoot() {
  const root = await mkdtemp(join(tmpdir(), 'free-studio-host-'))
  roots.push(root)
  await writeFile(
    join(root, 'index.html'),
    '<base href="/" /><main>Production Studio</main>',
  )
  return root
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('production Studio process', () => {
  it('serves the shared app and shuts runtime plus listener down once on signal', async () => {
    const runtimeStopped = Promise.withResolvers<void>()
    const runtime: StudioRuntime = {
      run: vi.fn(async (signal) => {
        signal.addEventListener('abort', () => runtimeStopped.resolve(), {
          once: true,
        })
        await runtimeStopped.promise
      }),
      close: vi.fn(async () => undefined),
    }
    const close = vi.fn((callback: (error?: Error) => void) => {
      callback()
      return server
    })
    const server = { close } as unknown as ServerType
    let fetchApplication:
      | ((request: Request, environment: unknown) => unknown)
      | undefined
    const serve = vi.fn((options, listening?: (info: {
      address: string
      port: number
      family: string
    }) => void) => {
      fetchApplication = options.fetch
      listening?.({ address: '127.0.0.1', port: 5173, family: 'IPv4' })
      return server
    })
    const signalEmitter = new EventEmitter() as EventEmitter &
      StudioSignalTarget
    const logger = { log: vi.fn(), error: vi.fn() }
    const providerRuntime = { close: vi.fn(async () => undefined) }
    const config = loadStudioServerConfig({
      STUDIO_ORIGIN: 'http://127.0.0.1:5173',
      STUDIO_BASE_PATH: '/free',
      FREE_SESSION_SECRET: SECRET,
      FREE_STUDIO_PROXY: 'loopback',
      FREE_ENTRA_TENANT_ID: '10000000-0000-4000-8000-000000000001',
      FREE_ENTRA_CLIENT_ID: '10000000-0000-4000-8000-000000000002',
      FREE_ENTRA_CLIENT_CERT_PATH: '/unused/in/injected-test.pem',
      FREE_ENTRA_CLIENT_CERT_THUMBPRINT: 'AB'.repeat(32),
    })

    const host = await startStudioServer(config, {
      clientRoot: await clientRoot(),
      runtime,
      serve: serve as never,
      signals: signalEmitter,
      logger,
      providerRuntime,
      identityProvider: createFakeEntraIdentityProvider(),
    })
    expect(serve).toHaveBeenCalledOnce()
    expect(serve.mock.calls[0][0]).toMatchObject({
      hostname: '127.0.0.1',
      port: 5173,
    })
    expect(runtime.run).toHaveBeenCalledOnce()
    expect(logger.log).toHaveBeenCalledWith(
      'FREE Studio listening on 127.0.0.1:5173',
    )

    const health = (await fetchApplication!(
      new Request('http://127.0.0.1:5173/free/api/healthz'),
      {},
    )) as Response
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toEqual({ status: 'ok' })

    const signedOut = (await fetchApplication!(
      new Request('http://127.0.0.1:5173/free/auth/signed-out'),
      {},
    )) as Response
    expect(signedOut.status).toBe(200)
    expect(signedOut.headers.get('cache-control')).toBe('no-cache')
    expect(await signedOut.text()).toBe(
      '<base href="/free/" /><main>Production Studio</main>',
    )

    signalEmitter.emit('SIGTERM')
    await host.shutdown()
    await host.shutdown()
    expect(close).toHaveBeenCalledOnce()
    expect(runtime.close).toHaveBeenCalledOnce()
    expect(providerRuntime.close).toHaveBeenCalledOnce()
    await expect(runtimeStopped.promise).resolves.toBeUndefined()
    expect(signalEmitter.listenerCount('SIGINT')).toBe(0)
    expect(signalEmitter.listenerCount('SIGTERM')).toBe(0)
    expect(logger.error).not.toHaveBeenCalled()
  })
})
