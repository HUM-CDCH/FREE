import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquirePlaywrightPortLeaseForTest,
  acquirePlaywrightProjectLeaseForTest,
  playwrightViteArgumentsForTest,
  recoverPlaywrightStackForTest,
  spawnSupervisedProcessForTest,
  superviseViteForTest,
  teardownPlaywrightStackForTest,
  type PlaywrightPortLease,
  type RunningViteForTest,
  type ViteExitForTest,
} from '../e2e/playwrightStack.js'

const temporaryDirectories: string[] = []
const leases: PlaywrightPortLease[] = []

async function temporaryLifecycleDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'free-playwright-lifecycle-'))
  temporaryDirectories.push(directory)
  return directory
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  server.close()
  await once(server, 'close')
  return port
}

function uniqueComposeProject(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function trackLease(lease: PlaywrightPortLease): PlaywrightPortLease {
  leases.push(lease)
  return lease
}

async function writeLifecycleState(
  directory: string,
  lifecycleId: string,
): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'lifecycle.json'),
    JSON.stringify({ lifecycleId, wrapperPid: process.pid }),
    'utf8',
  )
}

async function writeCompletionMarker(
  directory: string,
  lifecycleId: string,
): Promise<void> {
  const completionDirectory = `${directory}-completions`
  await mkdir(completionDirectory, { recursive: true })
  await writeFile(
    join(completionDirectory, `${lifecycleId}.json`),
    JSON.stringify({ lifecycleId }),
    'utf8',
  )
}

async function waitForTeardownRequest(
  directory: string,
  lifecycleId: string,
): Promise<void> {
  await vi.waitFor(
    async () => {
      const request: unknown = JSON.parse(
        await readFile(join(directory, 'teardown-request.json'), 'utf8'),
      )
      expect(request).toEqual({ lifecycleId })
    },
    { interval: 10, timeout: 1_000 },
  )
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(leases.splice(0).map((lease) => lease.release()))
  await Promise.all(
    temporaryDirectories.splice(0).flatMap((directory) => [
      rm(directory, { force: true, recursive: true }),
      rm(`${directory}-completions`, { force: true, recursive: true }),
    ]),
  )
})

describe('Playwright stack leases', () => {
  it('allows exactly one concurrent holder for the configured application port', async () => {
    const port = await unusedLoopbackPort()
    const attempts = await Promise.allSettled([
      acquirePlaywrightPortLeaseForTest(port),
      acquirePlaywrightPortLeaseForTest(port),
    ])
    const holders = attempts
      .filter(
        (attempt): attempt is PromiseFulfilledResult<PlaywrightPortLease> =>
          attempt.status === 'fulfilled',
      )
      .map((attempt) => trackLease(attempt.value))

    expect(holders).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(
      1,
    )
    await expect(acquirePlaywrightPortLeaseForTest(port)).rejects.toThrow(
      /startup lease/,
    )

    await holders[0].release()
    expect(
      trackLease(await acquirePlaywrightPortLeaseForTest(port)),
    ).toBeDefined()
  })

  it('releases after an accepted readiness connection without waiting on its socket', async () => {
    const port = await unusedLoopbackPort()
    const lease = trackLease(await acquirePlaywrightPortLeaseForTest(port))
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.on('error', () => undefined)
    const closed = once(socket, 'close', {
      signal: AbortSignal.timeout(1_000),
    })

    try {
      await once(socket, 'connect')
      const released = lease.release()
      await closed
      await expect(released).resolves.toBeUndefined()
    } finally {
      socket.destroy()
    }
  })

  it('serializes one Compose project independently of application-port choices', async () => {
    const composeProject = uniqueComposeProject('lease_project')
    trackLease(await acquirePlaywrightProjectLeaseForTest(composeProject))

    await expect(
      acquirePlaywrightProjectLeaseForTest(composeProject),
    ).rejects.toThrow(/project lease/)
  })
})

describe('Playwright stack recovery', () => {
  it('clears recognized stale markers after corrupt-state recovery', async () => {
    const directory = await temporaryLifecycleDirectory()
    const lifecycleId = 'recovery-lifecycle-0001'
    const priorLifecycleId = 'prior-recovery-lifecycle-0002'
    await writeFile(join(directory, 'lifecycle.json'), '{not-json', 'utf8')
    await writeCompletionMarker(directory, lifecycleId)
    await writeCompletionMarker(directory, priorLifecycleId)
    await writeFile(
      join(`${directory}-completions`, 'unrecognized.json'),
      JSON.stringify({ lifecycleId: 'not-this-file' }),
      'utf8',
    )
    const composeDown = vi.fn(async () => undefined)

    trackLease(
      await recoverPlaywrightStackForTest({
        composeDown,
        composeProject: uniqueComposeProject('recovery_project'),
        directory,
        port: await unusedLoopbackPort(),
      }),
    )

    expect(composeDown).toHaveBeenCalledOnce()
    await expect(readFile(join(directory, 'lifecycle.json'), 'utf8')).rejects.toMatchObject(
      { code: 'ENOENT' },
    )
    await expect(
      readFile(
        join(`${directory}-completions`, `${lifecycleId}.json`),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(
        join(`${directory}-completions`, `${priorLifecycleId}.json`),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(join(`${directory}-completions`, 'unrecognized.json'), 'utf8'),
    ).resolves.toBeTruthy()
  })

  it('does not signal a live numeric PID loaded from lifecycle metadata', async () => {
    const directory = await temporaryLifecycleDirectory()
    await writeFile(
      join(directory, 'lifecycle.json'),
      JSON.stringify({
        lifecycleId: 'unverified-lifecycle-0001',
        vitePid: process.pid,
        wrapperPid: process.pid,
      }),
      'utf8',
    )
    await writeCompletionMarker(directory, 'unverified-lifecycle-0001')
    const signalProcess = vi.spyOn(process, 'kill')

    trackLease(
      await recoverPlaywrightStackForTest({
        composeDown: async () => undefined,
        composeProject: uniqueComposeProject('pid_recovery_project'),
        directory,
        port: await unusedLoopbackPort(),
      }),
    )

    expect(signalProcess).not.toHaveBeenCalled()
    await expect(readFile(join(directory, 'lifecycle.json'), 'utf8')).rejects.toMatchObject(
      { code: 'ENOENT' },
    )
    await expect(
      readFile(
        join(
          `${directory}-completions`,
          'unverified-lifecycle-0001.json',
        ),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('Playwright stack teardown', () => {
  it('waits for the exact generation even when its lifecycle directory is removed and recreated', async () => {
    const directory = await temporaryLifecycleDirectory()
    const composeProject = uniqueComposeProject('generation_project')
    const lifecycleId = 'completed-lifecycle-0001'
    const nextLifecycleId = 'replacement-lifecycle-0002'
    await writeLifecycleState(directory, lifecycleId)
    trackLease(await acquirePlaywrightProjectLeaseForTest(composeProject))
    const composeDown = vi.fn(async () => undefined)
    vi.useFakeTimers()
    const teardown = teardownPlaywrightStackForTest({
      composeDown,
      composeProject,
      directory,
      lifecycleId,
      // Far beyond the fake time this test advances, so only the completion marker ends the wait.
      timeoutMs: 60_000,
    })
    let teardownSettled = false
    void teardown.then(
      () => {
        teardownSettled = true
      },
      () => {
        teardownSettled = true
      },
    )
    await waitForTeardownRequest(directory, lifecycleId)

    await rm(directory, { force: true, recursive: true })
    await vi.advanceTimersByTimeAsync(100)
    expect(teardownSettled).toBe(false)
    await writeLifecycleState(directory, nextLifecycleId)
    await writeCompletionMarker(directory, nextLifecycleId)
    await vi.advanceTimersByTimeAsync(100)
    expect(teardownSettled).toBe(false)
    await writeCompletionMarker(directory, lifecycleId)
    // The poll reads the marker with real file I/O between fake-timer sleeps. A read still in flight when one
    // advance returns schedules its next sleep after it, so keep the clock moving until the teardown settles.
    await vi.waitFor(
      async () => {
        await vi.advanceTimersByTimeAsync(50)
        expect(teardownSettled).toBe(true)
      },
      { interval: 20, timeout: 2_000 },
    )

    await expect(teardown).resolves.toBeUndefined()
    expect(composeDown).not.toHaveBeenCalled()
  })

  it('returns after successful cooperative cleanup without fallback Compose down', async () => {
    const directory = await temporaryLifecycleDirectory()
    const composeProject = uniqueComposeProject('cooperative_project')
    const lifecycleId = 'cooperative-lifecycle-0001'
    await writeLifecycleState(directory, lifecycleId)
    trackLease(await acquirePlaywrightProjectLeaseForTest(composeProject))
    const composeDown = vi.fn(async () => undefined)
    const teardown = teardownPlaywrightStackForTest({
      composeDown,
      composeProject,
      directory,
      lifecycleId,
    })
    await waitForTeardownRequest(directory, lifecycleId)

    await rm(directory, { force: true, recursive: true })
    await writeCompletionMarker(directory, lifecycleId)

    await expect(teardown).resolves.toBeUndefined()
    expect(composeDown).not.toHaveBeenCalled()
  })

  it('holds the project lease before running fallback Compose down', async () => {
    const directory = await temporaryLifecycleDirectory()
    const composeProject = uniqueComposeProject('fallback_project')
    const lifecycleId = 'fallback-lifecycle-0001'
    const composeDown = vi.fn(async () => {
      const [attempt] = await Promise.allSettled([
        acquirePlaywrightProjectLeaseForTest(composeProject),
      ])
      if (attempt.status === 'fulfilled') trackLease(attempt.value)
      expect(attempt.status).toBe('rejected')
    })

    await expect(
      teardownPlaywrightStackForTest({
        composeDown,
        composeProject,
        directory,
        lifecycleId,
      }),
    ).resolves.toBeUndefined()
    expect(composeDown).toHaveBeenCalledOnce()
  })

  it('preserves state when cooperative cleanup times out under a held project lease', async () => {
    const directory = await temporaryLifecycleDirectory()
    const composeProject = uniqueComposeProject('active_project')
    const lifecycleId = 'active-lifecycle-0001'
    await writeLifecycleState(directory, lifecycleId)
    trackLease(await acquirePlaywrightProjectLeaseForTest(composeProject))
    const composeDown = vi.fn(async () => undefined)
    const teardown = teardownPlaywrightStackForTest({
      composeDown,
      composeProject,
      directory,
      lifecycleId,
      timeoutMs: 25,
    })
    await waitForTeardownRequest(directory, lifecycleId)
    const rejection = expect(teardown).rejects.toThrow(
      /fallback Compose teardown was refused/,
    )
    await rejection
    expect(composeDown).not.toHaveBeenCalled()
    await expect(readFile(join(directory, 'lifecycle.json'), 'utf8')).resolves.toBeTruthy()
  })
})

describe('Playwright Vite ownership', () => {
  it('starts Vite with strict port ownership', () => {
    expect(playwrightViteArgumentsForTest(47_001).slice(1)).toEqual([
      '--port',
      '47001',
      '--strictPort',
    ])
  })
})

describe('Playwright Vite supervision', () => {
  /** A fake Vite whose exit the test decides. */
  function fakeVite(pid: number): RunningViteForTest & { exit: (exit: ViteExitForTest) => void } {
    const exited = Promise.withResolvers<ViteExitForTest>()
    return {
      child: { exitCode: null, signalCode: null } as RunningViteForTest['child'],
      exited: exited.promise,
      pid,
      exit: exited.resolve,
    }
  }

  it('a restartable web server respawns Vite after a SIGKILL and records its new PID', async () => {
    const vites = [fakeVite(11), fakeVite(22)]
    const spawn = vi.fn(async () => vites[spawn.mock.calls.length - 1]!)
    const recorded: number[] = []
    const teardown = Promise.withResolvers<void>()

    const outcome = superviseViteForTest({
      spawn,
      restartable: true,
      recordVite: async (pid) => { recorded.push(pid) },
      teardown: teardown.promise,
    })
    await vi.waitFor(() => expect(recorded).toEqual([11]))
    vites[0]!.exit({ code: null, signal: 'SIGKILL' })
    await vi.waitFor(() => expect(recorded).toEqual([11, 22]))
    expect(spawn).toHaveBeenCalledTimes(2)

    teardown.resolve()
    await expect(outcome).resolves.toEqual({ type: 'teardown', vite: vites[1] })
  })

  it('any other Vite exit still fails the web server, and so does a SIGKILL when not restartable', async () => {
    const crashed = fakeVite(11)
    const spawn = vi.fn(async () => crashed)
    const outcome = superviseViteForTest({
      spawn, restartable: true, recordVite: async () => {}, teardown: new Promise<void>(() => {}),
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    crashed.exit({ code: 1, signal: null })
    await expect(outcome).resolves.toEqual({ type: 'exit', exit: { code: 1, signal: null } })
    expect(spawn).toHaveBeenCalledTimes(1)

    const killed = fakeVite(12)
    const once = vi.fn(async () => killed)
    const plain = superviseViteForTest({
      spawn: once, restartable: false, recordVite: async () => {}, teardown: new Promise<void>(() => {}),
    })
    await vi.waitFor(() => expect(once).toHaveBeenCalledTimes(1))
    killed.exit({ code: null, signal: 'SIGKILL' })
    await expect(plain).resolves.toEqual({ type: 'exit', exit: { code: null, signal: 'SIGKILL' } })
    expect(once).toHaveBeenCalledTimes(1)
  })

  it("Vite's output is appended to the Studio log when one is named", async () => {
    const directory = await temporaryLifecycleDirectory()
    const log = join(directory, 'studio.log')
    await writeFile(log, 'earlier line\n', 'utf8')

    const child = await spawnSupervisedProcessForTest(
      process.execPath,
      ['-e', "console.log('hello from stdout'); console.error('hello from stderr')"],
      { cwd: directory, log },
    )
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null })

    await vi.waitFor(async () => {
      const contents = await readFile(log, 'utf8')
      expect(contents).toContain('earlier line')
      expect(contents).toContain('hello from stdout')
      expect(contents).toContain('hello from stderr')
    })
  })
})
