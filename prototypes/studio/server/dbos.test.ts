import { beforeEach, describe, expect, it, vi } from 'vitest'

// One ordered record of what the process did, shared by the DBOS and pg mocks.
const sdk = vi.hoisted(() => {
  const calls: string[] = []
  type FakeClient = {
    options: Record<string, unknown>
    registerQueue: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }
  const clients: FakeClient[] = []
  return {
    calls,
    clients,
    DBOS: {
      setConfig: vi.fn(() => {
        calls.push('setConfig')
      }),
      launch: vi.fn(async () => {
        calls.push('launch')
      }),
      isInitialized: vi.fn(() => false),
      registerQueue: vi.fn(async (name: string) => {
        calls.push(`registerQueue:${name}`)
      }),
      shutdown: vi.fn(async () => {
        calls.push('shutdown')
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
      enablePatching: true,
      enableOTLP: false,
      logLevel: 'info',
    })
  })

  it('reads the boot timestamp from the database clock, then registers workflows, then launches, then registers the queues', async () => {
    const { launchStudioDbos } = await freshModule()
    const register = vi.fn(() => {
      sdk.calls.push('register')
    })

    const dbos = await launchStudioDbos({ databaseUrl: URL, register })

    expect(sdk.calls).toEqual([
      'clock',
      'register',
      'setConfig',
      'launch',
      'registerQueue:studio',
      'registerQueue:suggest',
      'client:studio:dbos',
      'client:kei:kei_dbos',
    ])
    expect(dbos.bootTimestampMs).toBe(1789000000000)
  })

  it('registers the studio queue with a 100 ms polling floor and suggest with one global slot', async () => {
    const { launchStudioDbos } = await freshModule()

    await launchStudioDbos({ databaseUrl: URL, register: () => undefined })

    expect(sdk.DBOS.registerQueue.mock.calls).toEqual([
      ['studio', { minPollingIntervalMs: 100 }],
      ['suggest', { globalConcurrency: 1 }],
    ])
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

    await shutdownStudioDbos()
    await shutdownStudioDbos()

    expect(sdk.calls).toEqual(['shutdown', 'destroy:studio', 'destroy:kei'])
    expect(sdk.DBOS.shutdown).toHaveBeenCalledOnce()
    for (const client of sdk.clients) expect(client.destroy).toHaveBeenCalledOnce()
    expect(() => studioDbos()).toThrow('Studio has not launched DBOS in this process.')
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
