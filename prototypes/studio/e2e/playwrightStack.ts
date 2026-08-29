import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const composeFile = resolve(import.meta.dirname, 'playwright.compose.yaml')
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const studioDirectory = resolve(import.meta.dirname, '..')
const readinessTimeoutMs = 60_000
const shutdownTimeoutMs = 10_000
const viteCli = fileURLToPath(
  new URL('bin/vite.js', import.meta.resolve('vite/package.json')),
)

export const playwrightWebServerCommand =
  'node --import tsx e2e/playwrightWebServer.ts'

const environmentNames = {
  composeProject: 'FREE_PLAYWRIGHT_COMPOSE_PROJECT',
  databaseName: 'FREE_PLAYWRIGHT_DATABASE_NAME',
  oidcPort: 'FREE_PLAYWRIGHT_OIDC_PORT',
  postgresPort: 'FREE_PLAYWRIGHT_POSTGRES_PORT',
} as const

type PlaywrightStackDefaults = {
  applicationPort: number
  composeProject: string
  databaseName: `free_test_${string}`
  oidcPort: number
  postgresPort: number
}

type PlaywrightStackConfiguration = {
  applicationPort: number
  composeProject: string
  databaseName: string
  databaseUrl: string
  oidcIssuer: string
  oidcPort: number
  postgresPort: number
}

type CleanupOwner = 'global-teardown' | 'web-server'

type PlaywrightLifecycleState = {
  vitePid: number
  wrapperPid: number
}

function parsePort(name: string, fallback: number): number {
  const port = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error(`${name} must be a valid TCP port.`)
  return port
}

function parseComposeProject(fallback: string): string {
  const project = process.env[environmentNames.composeProject] ?? fallback
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project))
    throw new Error(
      `${environmentNames.composeProject} must contain only lowercase letters, numbers, hyphens, and underscores.`,
    )
  return project
}

function parseDatabaseName(fallback: string): string {
  const databaseName = process.env[environmentNames.databaseName] ?? fallback
  if (!/^free_test_[a-z0-9_]+$/.test(databaseName))
    throw new Error(
      `${environmentNames.databaseName} must start with free_test_ and contain only lowercase letters, numbers, and underscores.`,
    )
  return databaseName
}

export function configurePlaywrightStack(
  defaults: PlaywrightStackDefaults,
): PlaywrightStackConfiguration {
  const applicationPort = parsePort('FREE_PLAYWRIGHT_PORT', defaults.applicationPort)
  const oidcPort = parsePort(environmentNames.oidcPort, defaults.oidcPort)
  const postgresPort = parsePort(
    environmentNames.postgresPort,
    defaults.postgresPort,
  )
  if (
    applicationPort === oidcPort ||
    applicationPort === postgresPort ||
    oidcPort === postgresPort
  )
    throw new Error(
      'FREE Playwright application, OIDC, and PostgreSQL ports must be distinct.',
    )

  const composeProject = parseComposeProject(defaults.composeProject)
  const databaseName = parseDatabaseName(defaults.databaseName)
  const databaseUrl = `postgresql://free_e2e:free_e2e@127.0.0.1:${postgresPort}/${databaseName}`
  const oidcIssuer = `http://127.0.0.1:${oidcPort}/dev`

  process.env.FREE_PLAYWRIGHT_PORT = String(applicationPort)
  process.env[environmentNames.composeProject] = composeProject
  process.env[environmentNames.databaseName] = databaseName
  process.env[environmentNames.oidcPort] = String(oidcPort)
  process.env[environmentNames.postgresPort] = String(postgresPort)
  process.env.DATABASE_URL = databaseUrl
  process.env.EXTRACTION_TEST_DATABASE_URL = databaseUrl

  return {
    applicationPort,
    composeProject,
    databaseName,
    databaseUrl,
    oidcIssuer,
    oidcPort,
    postgresPort,
  }
}

function readConfiguredStack(): PlaywrightStackConfiguration {
  const applicationPort = parsePort('FREE_PLAYWRIGHT_PORT', Number.NaN)
  const composeProject = parseComposeProject('')
  const databaseName = parseDatabaseName('')
  const oidcPort = parsePort(environmentNames.oidcPort, Number.NaN)
  const postgresPort = parsePort(environmentNames.postgresPort, Number.NaN)

  return {
    applicationPort,
    composeProject,
    databaseName,
    databaseUrl: `postgresql://free_e2e:free_e2e@127.0.0.1:${postgresPort}/${databaseName}`,
    oidcIssuer: `http://127.0.0.1:${oidcPort}/dev`,
    oidcPort,
    postgresPort,
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  const { promise, resolve: resolveCommand, reject: rejectCommand } =
    Promise.withResolvers<void>()
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'inherit',
    shell: false,
  })
  child.once('error', rejectCommand)
  child.once('exit', (code, signal) => {
    if (code === 0) resolveCommand()
    else
      rejectCommand(
        new Error(
          `${command} ${args.join(' ')} exited with ${code ?? signal ?? 'an unknown status'}.`,
        ),
      )
  })
  return promise
}

function composeArgs(configuration: PlaywrightStackConfiguration): string[] {
  return [
    'compose',
    '--project-name',
    configuration.composeProject,
    '--file',
    composeFile,
  ]
}

async function composeDown(
  configuration: PlaywrightStackConfiguration,
): Promise<void> {
  await runCommand(
    'docker',
    [
      ...composeArgs(configuration),
      'down',
      '--volumes',
      '--remove-orphans',
    ],
    { cwd: studioDirectory },
  )
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve: resolveDelay } = Promise.withResolvers<void>()
  setTimeout(resolveDelay, milliseconds)
  return promise
}

async function waitForHealthyOidc(issuer: string): Promise<void> {
  const healthUrl = new URL('/isalive', issuer)
  const deadline = Date.now() + readinessTimeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(2_000),
      })
      if (response.ok) return
      lastError = new Error(`OIDC health check returned HTTP ${response.status}.`)
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }

  throw new Error(`Mock OIDC did not become healthy at ${healthUrl}.`, {
    cause: lastError,
  })
}

async function migrateDatabase(databaseUrl: string): Promise<void> {
  const environment = { ...process.env, DATABASE_URL: databaseUrl }
  if (process.platform === 'win32') {
    await runCommand(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', 'pnpm --filter db db:init'],
      {
        cwd: repositoryRoot,
        env: environment,
      },
    )
    return
  }

  await runCommand('pnpm', ['--filter', 'db', 'db:init'], {
    cwd: repositoryRoot,
    env: environment,
  })
}

function lifecyclePaths(configuration: PlaywrightStackConfiguration): {
  directory: string
  owner: string
  state: string
} {
  const directory = resolve(
    studioDirectory,
    `.playwright-stack-${configuration.composeProject}`,
  )
  return {
    directory,
    owner: resolve(directory, 'cleanup-owner'),
    state: resolve(directory, 'lifecycle.json'),
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  )
}

async function removeLifecycleArtifacts(
  configuration: PlaywrightStackConfiguration,
): Promise<void> {
  await rm(lifecyclePaths(configuration).directory, {
    force: true,
    recursive: true,
  })
}

async function claimCleanupOwnership(
  configuration: PlaywrightStackConfiguration,
  owner: CleanupOwner,
): Promise<boolean> {
  const paths = lifecyclePaths(configuration)
  await mkdir(paths.directory, { recursive: true })
  try {
    await writeFile(paths.owner, owner, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) return false
    throw error
  }
}

async function readCleanupOwner(
  configuration: PlaywrightStackConfiguration,
): Promise<CleanupOwner | undefined> {
  try {
    const owner = await readFile(lifecyclePaths(configuration).owner, 'utf8')
    if (owner === 'global-teardown' || owner === 'web-server') return owner
    throw new Error(`Unknown Playwright cleanup owner: ${owner}`)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined
    throw error
  }
}

async function writeLifecycleState(
  configuration: PlaywrightStackConfiguration,
  vitePid: number,
): Promise<void> {
  const paths = lifecyclePaths(configuration)
  await mkdir(paths.directory, { recursive: true })
  await writeFile(
    paths.state,
    JSON.stringify({ vitePid, wrapperPid: process.pid }),
    'utf8',
  )
}

function isProcessId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

async function readLifecycleState(
  configuration: PlaywrightStackConfiguration,
): Promise<PlaywrightLifecycleState | undefined> {
  let contents: string
  try {
    contents = await readFile(lifecyclePaths(configuration).state, 'utf8')
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined
    throw error
  }

  const state: unknown = JSON.parse(contents)
  if (
    typeof state !== 'object' ||
    state === null ||
    !('vitePid' in state) ||
    !isProcessId(state.vitePid) ||
    !('wrapperPid' in state) ||
    !isProcessId(state.wrapperPid)
  )
    throw new Error('The Playwright lifecycle file is invalid.')

  return { vitePid: state.vitePid, wrapperPid: state.wrapperPid }
}

function isRunning(pid: number, processGroup = false): boolean {
  try {
    process.kill(processGroup ? -pid : pid, 0)
    return true
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) return false
    if (hasErrorCode(error, 'EPERM')) return true
    throw error
  }
}

async function waitUntilStopped(
  pid: number,
  processGroup = false,
  timeoutMs = shutdownTimeoutMs,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isRunning(pid, processGroup)) return true
    await delay(50)
  }
  return !isRunning(pid, processGroup)
}

async function taskkillProcessTree(pid: number): Promise<void> {
  if (!isRunning(pid)) return
  try {
    await runCommand(
      'taskkill.exe',
      ['/PID', String(pid), '/T', '/F'],
      { cwd: studioDirectory },
    )
  } catch (error) {
    if (isRunning(pid)) throw error
  }
  if (!(await waitUntilStopped(pid)))
    throw new Error(`Process tree ${pid} remained alive after taskkill.`)
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if (!hasErrorCode(error, 'ESRCH')) throw error
  }
}

async function stopPosixProcess(
  pid: number,
  processGroup: boolean,
): Promise<void> {
  const target = processGroup ? -pid : pid
  if (!isRunning(pid, processGroup)) return
  signalProcess(target, 'SIGTERM')
  if (await waitUntilStopped(pid, processGroup)) return
  signalProcess(target, 'SIGKILL')
  if (!(await waitUntilStopped(pid, processGroup)))
    throw new Error(
      `${processGroup ? 'Process group' : 'Process'} ${pid} remained alive after SIGKILL.`,
    )
}

async function stopViteProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await taskkillProcessTree(pid)
    return
  }
  await stopPosixProcess(pid, true)
}

async function ensureWrapperStopped(pid: number): Promise<void> {
  if (pid === process.pid || (await waitUntilStopped(pid, false, 2_000))) return
  if (process.platform === 'win32') await taskkillProcessTree(pid)
  else await stopPosixProcess(pid, false)
}

async function waitForLifecycleCleanup(
  configuration: PlaywrightStackConfiguration,
): Promise<void> {
  const deadline = Date.now() + readinessTimeoutMs
  const { directory } = lifecyclePaths(configuration)
  while (Date.now() < deadline) {
    try {
      await readFile(resolve(directory, 'cleanup-owner'))
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return
      throw error
    }
    await delay(50)
  }
  throw new Error('Timed out waiting for the Playwright stack owner to clean up.')
}

type ViteExit = {
  code: number | null
  error?: unknown
  signal: NodeJS.Signals | null
}

type RunningVite = {
  exited: Promise<ViteExit>
  pid: number
}

async function spawnVite(
  configuration: PlaywrightStackConfiguration,
): Promise<RunningVite> {
  const child = spawn(
    process.execPath,
    [viteCli, '--port', String(configuration.applicationPort)],
    {
      cwd: studioDirectory,
      detached: process.platform !== 'win32',
      env: process.env,
      stdio: 'inherit',
    },
  )
  const started = Promise.withResolvers<void>()
  const exited = Promise.withResolvers<ViteExit>()
  child.once('spawn', started.resolve)
  child.once('error', (error) => {
    started.reject(error)
    exited.resolve({ code: null, error, signal: null })
  })
  child.once('exit', (code, signal) => exited.resolve({ code, signal }))
  await started.promise
  if (!child.pid) throw new Error('Vite started without a process ID.')
  return { exited: exited.promise, pid: child.pid }
}

function describeViteExit(exit: ViteExit): Error {
  if (exit.error)
    return new Error('The Playwright Vite server failed.', {
      cause: exit.error,
    })
  return new Error(
    `The Playwright Vite server exited unexpectedly with ${exit.code ?? exit.signal ?? 'an unknown status'}.`,
  )
}

async function cleanupFailedStart(
  configuration: PlaywrightStackConfiguration,
  setupError: unknown,
  vitePid?: number,
): Promise<never> {
  const cleanupErrors: unknown[] = []
  if (vitePid)
    try {
      await stopViteProcessTree(vitePid)
    } catch (error) {
      cleanupErrors.push(error)
    }
  try {
    await composeDown(configuration)
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    await removeLifecycleArtifacts(configuration)
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [setupError, ...cleanupErrors],
      'The Playwright web server failed to start and its cleanup also failed.',
    )
  throw setupError
}

async function setupPlaywrightStack(): Promise<PlaywrightStackConfiguration> {
  const configuration = readConfiguredStack()

  try {
    await removeLifecycleArtifacts(configuration)
    await composeDown(configuration)
    await runCommand(
      'docker',
      [
        ...composeArgs(configuration),
        'up',
        '--detach',
        '--force-recreate',
        '--wait',
        '--wait-timeout',
        String(readinessTimeoutMs / 1_000),
      ],
      { cwd: studioDirectory },
    )
    await waitForHealthyOidc(configuration.oidcIssuer)
    await migrateDatabase(configuration.databaseUrl)
  } catch (setupError) {
    const cleanupErrors: unknown[] = []
    try {
      await composeDown(configuration)
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      await removeLifecycleArtifacts(configuration)
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        [setupError, ...cleanupErrors],
        'Playwright stack setup failed and its cleanup also failed.',
      )
    throw setupError
  }

  return configuration
}

export async function startPlaywrightWebServer(): Promise<void> {
  const configuration = await setupPlaywrightStack()
  let vite: RunningVite | undefined

  try {
    vite = await spawnVite(configuration)
    await writeLifecycleState(configuration, vite.pid)
  } catch (setupError) {
    return cleanupFailedStart(configuration, setupError, vite?.pid)
  }

  const exit = await vite.exited
  const ownsCleanup = await claimCleanupOwnership(configuration, 'web-server')
  if (!ownsCleanup) {
    const owner = await readCleanupOwner(configuration)
    if (owner === 'global-teardown') return
    await waitForLifecycleCleanup(configuration)
    throw describeViteExit(exit)
  }

  const serverError = describeViteExit(exit)
  const cleanupErrors: unknown[] = []
  try {
    await stopViteProcessTree(vite.pid)
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    await composeDown(configuration)
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    await removeLifecycleArtifacts(configuration)
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [serverError, ...cleanupErrors],
      'The Playwright Vite server failed and stack cleanup also failed.',
    )
  throw serverError
}

export async function teardownPlaywrightStack(): Promise<void> {
  const configuration = readConfiguredStack()
  const ownsCleanup = await claimCleanupOwnership(
    configuration,
    'global-teardown',
  )
  if (!ownsCleanup) {
    await waitForLifecycleCleanup(configuration)
    return
  }

  try {
    const state = await readLifecycleState(configuration)
    if (!state) return
    await stopViteProcessTree(state.vitePid)
    await ensureWrapperStopped(state.wrapperPid)
    await composeDown(configuration)
  } finally {
    await removeLifecycleArtifacts(configuration)
  }
}
