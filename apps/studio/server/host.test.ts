import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { ServerType } from '@hono/node-server'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadStudioServerConfig } from './config.js'
import { createInMemoryEntraIdentityProvider } from '../test/support/inMemoryEntraIdentityProvider.js'
import {
  startStudioServer,
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

function productionConfig() {
  return loadStudioServerConfig({
    STUDIO_ORIGIN: 'http://127.0.0.1:5173',
    STUDIO_BASE_PATH: '/free',
    FREE_SESSION_SECRET: SECRET,
    FREE_STUDIO_PROXY: 'loopback',
    FREE_ENTRA_TENANT_ID: '10000000-0000-4000-8000-000000000001',
    FREE_ENTRA_CLIENT_ID: '10000000-0000-4000-8000-000000000002',
    FREE_ENTRA_CLIENT_CERT_PATH: '/unused/in/injected-test.pem',
    FREE_ENTRA_CLIENT_CERT_THUMBPRINT: 'AB'.repeat(32),
  })
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('production Studio process', () => {
  it('serves the shared app and shuts the listener, then DBOS, then the domain pool down once on signal', async () => {
    const order: string[] = []
    // The listener finishes closing later, as a real one does after its open connections end.
    const close = vi.fn((callback: (error?: Error) => void) => {
      setImmediate(() => {
        order.push('listener closed')
        callback()
      })
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
      order.push('serve')
      fetchApplication = options.fetch
      listening?.({ address: '127.0.0.1', port: 5173, family: 'IPv4' })
      return server
    })
    const signalEmitter = new EventEmitter() as EventEmitter &
      StudioSignalTarget
    const logger = { log: vi.fn(), error: vi.fn() }
    const providerRuntime = { close: vi.fn(async () => undefined) }
    const dbos = {
      launch: vi.fn(async () => {
        await Promise.resolve()
        order.push('dbos launched')
      }),
      shutdown: vi.fn(async () => {
        order.push('dbos shut down')
      }),
    }
    const closeDatabase = vi.fn(async () => {
      order.push('pool ended')
    })
    const host = await startStudioServer(productionConfig(), {
      clientRoot: await clientRoot(),
      serve: serve as never,
      signals: signalEmitter,
      logger,
      providerRuntime,
      identityProvider: createInMemoryEntraIdentityProvider(),
      dbos,
      closeDatabase,
    })
    expect(dbos.launch).toHaveBeenCalledOnce()
    expect(order).toEqual(['dbos launched', 'serve'])
    expect(serve).toHaveBeenCalledOnce()
    expect(serve.mock.calls[0][0]).toMatchObject({
      hostname: '127.0.0.1',
      port: 5173,
    })
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
    expect(dbos.shutdown).toHaveBeenCalledOnce()
    expect(order).toEqual([
      'dbos launched',
      'serve',
      'listener closed',
      'dbos shut down',
      'pool ended',
    ])
    expect(closeDatabase).toHaveBeenCalledOnce()
    expect(providerRuntime.close).toHaveBeenCalledOnce()
    expect(signalEmitter.listenerCount('SIGINT')).toBe(0)
    expect(signalEmitter.listenerCount('SIGTERM')).toBe(0)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('a listener that fails to close still shuts DBOS, the providers and the domain pool down', async () => {
    const refused = new Error('Server is not running.')
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => {
        setImmediate(() => callback(refused))
        return server
      }),
    } as unknown as ServerType
    const providerRuntime = { close: vi.fn(async () => undefined) }
    const dbos = {
      launch: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    }
    const closeDatabase = vi.fn(async () => undefined)
    const host = await startStudioServer(productionConfig(), {
      clientRoot: await clientRoot(),
      closeDatabase,
      serve: vi.fn(() => server) as never,
      signals: new EventEmitter() as EventEmitter & StudioSignalTarget,
      logger: { log: vi.fn(), error: vi.fn() },
      providerRuntime,
      identityProvider: createInMemoryEntraIdentityProvider(),
      dbos,
    })

    await expect(host.shutdown()).rejects.toBe(refused)

    expect(dbos.shutdown).toHaveBeenCalledOnce()
    expect(providerRuntime.close).toHaveBeenCalledOnce()
    expect(closeDatabase).toHaveBeenCalledOnce()
  })

  it('a DBOS that fails to stop still ends the domain pool', async () => {
    const stuck = new Error('DBOS failed to stop.')
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => {
        setImmediate(() => callback())
        return server
      }),
    } as unknown as ServerType
    const closeDatabase = vi.fn(async () => undefined)
    const host = await startStudioServer(productionConfig(), {
      clientRoot: await clientRoot(),
      closeDatabase,
      serve: vi.fn(() => server) as never,
      signals: new EventEmitter() as EventEmitter & StudioSignalTarget,
      logger: { log: vi.fn(), error: vi.fn() },
      providerRuntime: { close: vi.fn(async () => undefined) },
      identityProvider: createInMemoryEntraIdentityProvider(),
      dbos: { launch: vi.fn(async () => undefined), shutdown: vi.fn(async () => { throw stuck }) },
    })

    await expect(host.shutdown()).rejects.toBe(stuck)
    expect(closeDatabase).toHaveBeenCalledOnce()
  })
})
