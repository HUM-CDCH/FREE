import { beforeEach, describe, expect, it, vi } from 'vitest'

// One ordered record of what the process did, shared by the DBOS and pg mocks.
// DBOS is initialized from launch until shutdown, as the real SDK reports it.
const sdk = vi.hoisted(() => {
  const calls: string[] = []
  const state = { initialized: false }
  type FakeClient = {
    options: Record<string, unknown>
    registerQueue: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }
  const clients: FakeClient[] = []
  return {
    calls,
    clients,
    state,
    DBOS: {
      setConfig: vi.fn(() => {
        calls.push('setConfig')
      }),
      launch: vi.fn(async () => {
        calls.push('launch')
        state.initialized = true
      }),
      isInitialized: vi.fn(() => state.initialized),
      registerQueue: vi.fn(async (name: string) => {
        calls.push(`registerQueue:${name}`)
      }),
      shutdown: vi.fn(async () => {
        calls.push('shutdown')
        state.initialized = false
      }),
    },
    create: vi.fn(async (options: Record<string, unknown>) => {
      calls.push(
        `client:${String(options.applicationName)}:${String(options.systemDatabaseSchemaName)}`,
      )
      const client: FakeClient = {
        options,
        registerQueue: vi.fn(),
        destroy: vi.fn(async () => {
          calls.push(`destroy:${String(options.applicationName)}`)
        }),
      }
      clients.push(client)
      return client
    }),
  }
})

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: sdk.DBOS,
  DBOSClient: { create: sdk.create },
}))

vi.mock('pg', () => {
  class Client {
    connect = vi.fn(async () => undefined)
    query = vi.fn(async () => {
      sdk.calls.push('clock')
      return { rows: [{ ms: '1789000000000' }] }
    })
    end = vi.fn(async () => undefined)
  }
  class Pool {}
  return { default: { Client, Pool }, Client, Pool }
})

const URL = 'postgresql://x'

async function freshModule() {
  return import('./dbos.js')
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  sdk.calls.length = 0
  sdk.clients.length = 0
  sdk.state.initialized = false
  // The launch record is process-global; each test starts from a process that never launched.
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('free.studio.dbos')]
})

describe('Studio DBOS', () => {
  it('configures Studio\'s DBOS application: studio in schema dbos, version studio@1, executor studio, patching on', async () => {
    const { studioDbosConfig } = await freshModule()

    expect(studioDbosConfig({ databaseUrl: URL })).toEqual({
      name: 'studio',
      systemDatabaseUrl: URL,
      systemDatabaseSchemaName: 'dbos',
      applicationVersion: 'studio@1',
      executorID: 'studio',
      systemDatabasePoolSize: 5,
      enablePatching: true,
      enableOTLP: false,
      logLevel: 'info',
    })
  })

  it('reads the boot clock, registers workflows, prepares clients, then launches and registers queues', async () => {
    const { launchStudioDbos } = await freshModule()
    const register = vi.fn(() => {
      sdk.calls.push('register')
    })

    const dbos = await launchStudioDbos({ databaseUrl: URL, register })

    expect(sdk.calls).toEqual([
      'clock',
      'register',
      'setConfig',
      'client:studio:dbos',
      'client:kei:kei_dbos',
      'launch',
      'registerQueue:studio',
      'registerQueue:suggest',
      'registerQueue:gc',
    ])
    expect(dbos.bootTimestampMs).toBe(1789000000000)
  })

  it('exposes both clients to recovered work dispatched during launch', async () => {
    const { launchStudioDbos, studioDbos } = await freshModule()
    sdk.DBOS.launch.mockImplementationOnce(async () => {
      expect(studioDbos()).toMatchObject({ admission: sdk.clients[0], kei: sdk.clients[1] })
      sdk.state.initialized = true
    })

    await launchStudioDbos({ databaseUrl: URL, register: () => undefined })
  })

  it('registers the studio queue and one global slot each for suggest and gc', async () => {
    const { launchStudioDbos } = await freshModule()

    await launchStudioDbos({ databaseUrl: URL, register: () => undefined })

    expect(sdk.DBOS.registerQueue.mock.calls).toEqual([
      ['studio', { minPollingIntervalMs: 100 }],
      ['suggest', { globalConcurrency: 1 }],
      ['gc', { globalConcurrency: 1 }],
    ])
  })

  it('applies schedules only when a host asks, after all queues exist', async () => {
    const { launchStudioDbos } = await freshModule()
    const schedule = vi.fn(async () => { sdk.calls.push('schedule') })
    await launchStudioDbos({ databaseUrl: URL, register: () => undefined, schedule })
    expect(sdk.calls.slice(-2)).toEqual(['registerQueue:gc', 'schedule'])
    expect(schedule).toHaveBeenCalledOnce()
  })

  it('creates the admission client as studio on dbos and the kei client as kei on kei_dbos', async () => {
    const { launchStudioDbos } = await freshModule()

    const dbos = await launchStudioDbos({ databaseUrl: URL, register: () => undefined })

    expect(sdk.create.mock.calls).toEqual([
      [
        {
          systemDatabaseUrl: URL,
          systemDatabaseSchemaName: 'dbos',
          systemDatabasePoolSize: 2,
          applicationName: 'studio',
        },
      ],
      [
        {
          systemDatabaseUrl: URL,
          systemDatabaseSchemaName: 'kei_dbos',
          systemDatabasePoolSize: 4,
          applicationName: 'kei',
        },
      ],
    ])
    expect(dbos.admission).toBe(sdk.clients[0])
    expect(dbos.kei).toBe(sdk.clients[1])
    // kei owns its lanes: a client's registerQueue would overwrite their limits.
    for (const client of sdk.clients) expect(client.registerQueue).not.toHaveBeenCalled()
  })

  it('launches once per process: a second call returns the first launch and never launches again', async () => {
    const { launchStudioDbos } = await freshModule()
    const register = vi.fn()

    const first = launchStudioDbos({ databaseUrl: URL, register })
    const second = launchStudioDbos({ databaseUrl: 'postgresql://other', register })

    expect(second).toBe(first)
    await first
    expect(launchStudioDbos({ databaseUrl: URL, register })).toBe(first)
    expect(sdk.DBOS.launch).toHaveBeenCalledOnce()
    expect(register).toHaveBeenCalledOnce()
  })

  it('every instance of this module shares the one launch: a reloaded module reuses it and never launches again', async () => {
    // Vite evaluates server/dbos.ts afresh after an edit to it and on every dev-server restart.
    const first = await freshModule()
    const register = vi.fn()
    const launched = await first.launchStudioDbos({ databaseUrl: URL, register })
    vi.resetModules()
    const reloaded = await freshModule()
    expect(reloaded).not.toBe(first)

    await expect(
      reloaded.launchStudioDbos({ databaseUrl: URL, register: vi.fn() }),
    ).resolves.toBe(launched)
    expect(reloaded.studioDbos()).toBe(launched)
    expect(sdk.DBOS.launch).toHaveBeenCalledOnce()
    expect(register).toHaveBeenCalledOnce()

    await reloaded.shutdownStudioDbos()
    expect(() => first.studioDbos()).toThrow('Studio has not launched DBOS in this process.')
    expect(sdk.DBOS.shutdown).toHaveBeenCalledOnce()
  })

  it('a client preparation failure closes the client it created, so a retry launches afresh', async () => {
    const { launchStudioDbos, studioDbos } = await freshModule()
    const unreachable = new Error('kei client failed')
    sdk.create
      .mockImplementationOnce(sdk.create.getMockImplementation()!)
      .mockRejectedValueOnce(unreachable)

    await expect(
      launchStudioDbos({ databaseUrl: URL, register: () => undefined }),
    ).rejects.toBe(unreachable)
    expect(sdk.calls.slice(-3)).toEqual([
      'client:studio:dbos',
      'shutdown',
      'destroy:studio',
    ])
    expect(sdk.state.initialized).toBe(false)
    expect(() => studioDbos()).toThrow('Studio has not launched DBOS in this process.')

    const retried = await launchStudioDbos({ databaseUrl: URL, register: () => undefined })
    expect(studioDbos()).toBe(retried)
    expect(sdk.DBOS.launch).toHaveBeenCalledOnce()
  })

  it('a post-launch queue failure withdraws exposed clients and closes both pools', async () => {
    const { launchStudioDbos, studioDbos } = await freshModule()
    const unavailable = new Error('queue registration failed')
    sdk.DBOS.registerQueue.mockRejectedValueOnce(unavailable)
    sdk.DBOS.shutdown.mockImplementationOnce(async () => {
      // A previously claimed workflow can still dispatch while shutdown drains queue polls.
      expect(studioDbos()).toMatchObject({ admission: sdk.clients[0], kei: sdk.clients[1] })
      sdk.state.initialized = false
    })

    await expect(launchStudioDbos({ databaseUrl: URL, register: () => undefined })).rejects.toBe(unavailable)
    expect(() => studioDbos()).toThrow('Studio has not launched DBOS in this process.')
    expect(sdk.DBOS.shutdown).toHaveBeenCalledOnce()
    for (const client of sdk.clients) expect(client.destroy).toHaveBeenCalledOnce()
  })

  it('refuses to launch when DBOS was launched elsewhere in this process', async () => {
    const { launchStudioDbos } = await freshModule()
    sdk.DBOS.isInitialized.mockReturnValueOnce(true)
    const register = vi.fn()

    expect(() => launchStudioDbos({ databaseUrl: URL, register })).toThrow(
      /launched outside launchStudioDbos/,
    )
    expect(sdk.DBOS.setConfig).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
  })

  it('studioDbos() throws before launch and returns the clients after it', async () => {
    const { launchStudioDbos, studioDbos } = await freshModule()

    expect(() => studioDbos()).toThrow('Studio has not launched DBOS in this process.')
    const launched = await launchStudioDbos({ databaseUrl: URL, register: () => undefined })

    expect(studioDbos()).toBe(launched)
    expect(studioDbos()).toMatchObject({
      admission: sdk.clients[0],
      kei: sdk.clients[1],
    })
  })

  it('shutdown stops DBOS and destroys both clients once; a second shutdown does nothing', async () => {
    const { launchStudioDbos, shutdownStudioDbos, studioDbos } = await freshModule()
    await launchStudioDbos({ databaseUrl: URL, register: () => undefined })
    sdk.calls.length = 0
    sdk.DBOS.shutdown.mockImplementationOnce(async () => {
      expect(studioDbos()).toMatchObject({ admission: sdk.clients[0], kei: sdk.clients[1] })
      sdk.calls.push('shutdown')
      sdk.state.initialized = false
    })

    await shutdownStudioDbos()
    await shutdownStudioDbos()

    expect(sdk.calls).toEqual(['shutdown', 'destroy:studio', 'destroy:kei'])
    expect(sdk.DBOS.shutdown).toHaveBeenCalledOnce()
    for (const client of sdk.clients) expect(client.destroy).toHaveBeenCalledOnce()
    expect(() => studioDbos()).toThrow('Studio has not launched DBOS in this process.')
  })

  it('a new launch waits for shutdown to finish before starting DBOS again', async () => {
    const { launchStudioDbos, shutdownStudioDbos, studioDbos } = await freshModule()
    await launchStudioDbos({ databaseUrl: URL, register: () => undefined })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    sdk.DBOS.shutdown.mockImplementationOnce(async () => {
      expect(studioDbos()).toBeDefined()
      await held
      sdk.state.initialized = false
    })

    const stopping = shutdownStudioDbos()
    await vi.waitFor(() => expect(sdk.DBOS.shutdown).toHaveBeenCalledOnce())
    const restarting = launchStudioDbos({ databaseUrl: URL, register: () => undefined })
    expect(sdk.DBOS.launch).toHaveBeenCalledOnce()
    release()
    await stopping
    await restarting
    expect(sdk.DBOS.launch).toHaveBeenCalledTimes(2)
  })

  it('shutdown closes both clients even when DBOS fails to stop', async () => {
    const { launchStudioDbos, shutdownStudioDbos } = await freshModule()
    await launchStudioDbos({ databaseUrl: URL, register: () => undefined })
    const stuck = new Error('DBOS did not stop')
    sdk.DBOS.shutdown.mockRejectedValueOnce(stuck)

    await expect(shutdownStudioDbos()).rejects.toBe(stuck)

    for (const client of sdk.clients) expect(client.destroy).toHaveBeenCalledOnce()
  })

  it('awaitWorkflowOutcome returns a finished workflow\'s output and a stopped workflow\'s status, and times out without waiting past its deadline', async () => {
    const { awaitWorkflowOutcome } = await freshModule()
    const scripted = (...responses: Array<Array<Record<string, unknown>>>) => ({
      listWorkflows: vi.fn(async () => responses.shift() ?? responses.at(-1) ?? []),
    })

    const finishing = scripted(
      [{ status: 'PENDING' }],
      [{ status: 'SUCCESS', output: { ok: true } }],
    )
    await expect(
      awaitWorkflowOutcome(finishing as never, 'wf-1', { timeoutMs: 1000, intervalMs: 1 }),
    ).resolves.toEqual({ state: 'finished', output: { ok: true } })
    expect(finishing.listWorkflows).toHaveBeenCalledTimes(2)
    expect(finishing.listWorkflows).toHaveBeenCalledWith({
      workflowIDs: ['wf-1'],
      loadInput: false,
      loadOutput: true,
    })

    await expect(
      awaitWorkflowOutcome(scripted([{ status: 'CANCELLED' }]) as never, 'wf-2', {
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({ state: 'stopped', status: 'CANCELLED' })

    await expect(
      awaitWorkflowOutcome(scripted([]) as never, 'wf-missing', { timeoutMs: 1000 }),
    ).resolves.toEqual({ state: 'stopped', status: 'MISSING' })

    // The default interval is 500 ms; the 5 ms deadline caps the wait.
    const pending = { listWorkflows: vi.fn(async () => [{ status: 'PENDING' }]) }
    const started = performance.now()
    await expect(
      awaitWorkflowOutcome(pending as never, 'wf-3', { timeoutMs: 5 }),
    ).resolves.toEqual({ state: 'timed-out' })
    expect(performance.now() - started).toBeLessThan(400)

    const aborted = new AbortController()
    const reason = new Error('The caller gave up.')
    aborted.abort(reason)
    await expect(
      awaitWorkflowOutcome(pending as never, 'wf-4', {
        timeoutMs: 1000,
        signal: aborted.signal,
      }),
    ).rejects.toBe(reason)

    // An abort while waiting between reads rejects with the same reason.
    const waiting = new AbortController()
    const later = new Error('The request closed.')
    const outcome = awaitWorkflowOutcome(pending as never, 'wf-5', {
      timeoutMs: 60_000,
      signal: waiting.signal,
    })
    setTimeout(() => waiting.abort(later), 5)
    await expect(outcome).rejects.toBe(later)
  })
})
