import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
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
  lifecycleId: 'FREE_PLAYWRIGHT_LIFECYCLE_ID',
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
  lifecycleId: string
  oidcIssuer: string
  oidcPort: number
  postgresPort: number
}

type PlaywrightLifecycleState = {
  lifecycleId: string
  vitePid?: number
  wrapperPid: number
}

type LifecycleStateSnapshot =
  | { exists: false }
  | { error: unknown; exists: true }
  | { exists: true; state: PlaywrightLifecycleState }

type LifecyclePaths = {
  completionDirectory: string
  directory: string
  request: string
  state: string
}

type TeardownRequest = {
  lifecycleId: string
}

export type PlaywrightPortLease = {
  release: () => Promise<void>
}


function parsePort(name: string, fallback: number): number {
  const port = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error(`${name} must be a valid TCP port.`)
  return port
}

function validateComposeProject(project: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project))
    throw new Error(
      `${name} must contain only lowercase letters, numbers, hyphens, and underscores.`,
    )
  return project
}

function parseComposeProject(fallback: string): string {
  return validateComposeProject(
    process.env[environmentNames.composeProject] ?? fallback,
    environmentNames.composeProject,
  )
}

function parseDatabaseName(fallback: string): string {
  const databaseName = process.env[environmentNames.databaseName] ?? fallback
  if (!/^free_test_[a-z0-9_]+$/.test(databaseName))
    throw new Error(
      `${environmentNames.databaseName} must start with free_test_ and contain only lowercase letters, numbers, and underscores.`,
    )
  return databaseName
}

function isLifecycleId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[a-zA-Z0-9-]{16,128}$/.test(value)
  )
}

function validateLifecycleId(lifecycleId: unknown): string {
  if (!isLifecycleId(lifecycleId))
    throw new Error(`${environmentNames.lifecycleId} is invalid.`)
  return lifecycleId
}

function parseLifecycleId(fallback?: string): string {
  return validateLifecycleId(
    process.env[environmentNames.lifecycleId] ?? fallback,
  )
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
  const projectLeasePort = projectLeasePortForComposeProject(composeProject)
  if (
    projectLeasePort === applicationPort ||
    projectLeasePort === oidcPort ||
    projectLeasePort === postgresPort
  )
    throw new Error(
      `The Compose project reserves loopback port ${projectLeasePort} for its Playwright lifecycle lease; configure different application, OIDC, and PostgreSQL ports.`,
    )
  const databaseName = parseDatabaseName(defaults.databaseName)
  const lifecycleId = parseLifecycleId(randomUUID())
  const databaseUrl = `postgresql://free_e2e:free_e2e@127.0.0.1:${postgresPort}/${databaseName}`
  const oidcIssuer = `http://127.0.0.1:${oidcPort}/dev`

  process.env.FREE_PLAYWRIGHT_PORT = String(applicationPort)
  process.env[environmentNames.composeProject] = composeProject
  process.env[environmentNames.databaseName] = databaseName
  process.env[environmentNames.lifecycleId] = lifecycleId
  process.env[environmentNames.oidcPort] = String(oidcPort)
  process.env[environmentNames.postgresPort] = String(postgresPort)
  process.env.DATABASE_URL = databaseUrl
  process.env.EXTRACTION_TEST_DATABASE_URL = databaseUrl

  return {
    applicationPort,
    composeProject,
    databaseName,
    databaseUrl,
    lifecycleId,
    oidcIssuer,
    oidcPort,
    postgresPort,
  }
}

function readConfiguredStack(): PlaywrightStackConfiguration {
  const applicationPort = parsePort('FREE_PLAYWRIGHT_PORT', Number.NaN)
  const composeProject = parseComposeProject('')
  const databaseName = parseDatabaseName('')
  const lifecycleId = parseLifecycleId()
  const oidcPort = parsePort(environmentNames.oidcPort, Number.NaN)
  const postgresPort = parsePort(environmentNames.postgresPort, Number.NaN)

  return {
    applicationPort,
    composeProject,
    databaseName,
    databaseUrl: `postgresql://free_e2e:free_e2e@127.0.0.1:${postgresPort}/${databaseName}`,
    lifecycleId,
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

async function composeUp(
  configuration: PlaywrightStackConfiguration,
): Promise<void> {
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
      { cwd: repositoryRoot, env: environment },
    )
    return
  }

  await runCommand('pnpm', ['--filter', 'db', 'db:init'], {
    cwd: repositoryRoot,
    env: environment,
  })
}

function lifecyclePaths(
  configuration: Pick<PlaywrightStackConfiguration, 'composeProject'>,
): LifecyclePaths {
  return lifecyclePathsForDirectory(
    resolve(
      studioDirectory,
      `.playwright-stack-${configuration.composeProject}`,
    ),
  )
}

function lifecyclePathsForDirectory(directory: string): LifecyclePaths {
  return {
    completionDirectory: `${directory}-completions`,
    directory,
    request: resolve(directory, 'teardown-request.json'),
    state: resolve(directory, 'lifecycle.json'),
  }
}

function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.includes(error.code)
  )
}

function isProcessId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

// Stay below Windows' default dynamic client-port range (49152–65535);
// transient outbound connections must not make project ownership flaky.
const projectLeasePortStart = 30_000
const projectLeasePortCount = 10_000

function projectLeasePortForComposeProject(composeProject: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < composeProject.length; index += 1) {
    hash ^= composeProject.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return projectLeasePortStart + ((hash >>> 0) % projectLeasePortCount)
}

async function acquireLoopbackLease(
  port: number,
  unavailableMessage: string,
): Promise<PlaywrightPortLease> {
  const server = createServer((socket) => socket.destroy())
  const { promise, resolve: resolveListen, reject: rejectListen } =
    Promise.withResolvers<void>()
  const rejectOnError = (error: Error) => rejectListen(error)
  server.once('error', rejectOnError)
  server.listen({ exclusive: true, host: '127.0.0.1', port }, () => {
    server.removeListener('error', rejectOnError)
    resolveListen()
  })

  try {
    await promise
  } catch (error) {
    throw new Error(unavailableMessage, { cause: error })
  }

  let released = false
  return {
    release: async () => {
      if (released) return
      released = true
      const { promise: closed, resolve, reject } =
        Promise.withResolvers<void>()
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
      await closed
    },
  }
}

function acquirePortLease(port: number): Promise<PlaywrightPortLease> {
  return acquireLoopbackLease(
    port,
    `Cannot acquire the Playwright startup lease on 127.0.0.1:${port}; another server or startup owns the configured application port.`,
  )
}

function acquireProjectLease(
  composeProject: string,
): Promise<PlaywrightPortLease> {
  const port = projectLeasePortForComposeProject(composeProject)
  return acquireLoopbackLease(
    port,
    `Cannot acquire the Playwright project lease for "${composeProject}" on 127.0.0.1:${port}; that Compose project or a colliding project lease is already active.`,
  )
}

export function acquirePlaywrightPortLeaseForTest(
  port: number,
): Promise<PlaywrightPortLease> {
  return acquirePortLease(port)
}

export function acquirePlaywrightProjectLeaseForTest(
  composeProject: string,
): Promise<PlaywrightPortLease> {
  return acquireProjectLease(
    validateComposeProject(composeProject, 'Playwright test Compose project'),
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false
    throw error
  }
}

function parseLifecycleState(value: unknown): PlaywrightLifecycleState {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('lifecycleId' in value) ||
    !isLifecycleId(value.lifecycleId) ||
    !('wrapperPid' in value) ||
    !isProcessId(value.wrapperPid) ||
    ('vitePid' in value &&
      value.vitePid !== undefined &&
      !isProcessId(value.vitePid))
  )
    throw new Error('The Playwright lifecycle file is invalid.')
  return {
    lifecycleId: value.lifecycleId,
    vitePid:
      'vitePid' in value && isProcessId(value.vitePid)
        ? value.vitePid
        : undefined,
    wrapperPid: value.wrapperPid,
  }
}

async function readLifecycleState(
  paths: LifecyclePaths,
): Promise<LifecycleStateSnapshot> {
  let contents: string
  try {
    contents = await readFile(paths.state, 'utf8')
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      if (await pathExists(paths.directory))
        return {
          error: new Error('The Playwright lifecycle directory has no state file.'),
          exists: true,
        }
      return { exists: false }
    }
    return { error, exists: true }
  }

  try {
    const value: unknown = JSON.parse(contents)
    return { exists: true, state: parseLifecycleState(value) }
  } catch (error) {
    return { error, exists: true }
  }
}

async function writeLifecycleState(
  paths: LifecyclePaths,
  lifecycleId: string,
  vitePid?: number,
): Promise<void> {
  await mkdir(paths.directory, { recursive: true })
  const temporary = `${paths.state}.${process.pid}.${randomUUID()}`
  await writeFile(
    temporary,
    JSON.stringify({ lifecycleId, vitePid, wrapperPid: process.pid }),
    { encoding: 'utf8', flag: 'wx' },
  )
  await rename(temporary, paths.state)
}

async function readTeardownRequest(
  paths: LifecyclePaths,
): Promise<TeardownRequest | undefined> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(paths.request, 'utf8'))
  } catch {
    return undefined
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('lifecycleId' in value) ||
    typeof value.lifecycleId !== 'string'
  )
    return undefined
  return { lifecycleId: value.lifecycleId }
}

async function writeTeardownRequest(
  paths: LifecyclePaths,
  lifecycleId: string,
): Promise<void> {
  await mkdir(paths.directory, { recursive: true })
  await writeFile(paths.request, JSON.stringify({ lifecycleId }), 'utf8')
}

async function waitForTeardownRequest(
  paths: LifecyclePaths,
  lifecycleId: string,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const request = await readTeardownRequest(paths)
    if (request?.lifecycleId === lifecycleId) return
    await delay(50)
  }
  throw signal.reason
}

function completionMarkerPath(
  paths: LifecyclePaths,
  lifecycleId: string,
): string {
  return resolve(paths.completionDirectory, `${lifecycleId}.json`)
}

async function readLifecycleCompletion(
  paths: LifecyclePaths,
  lifecycleId: string,
): Promise<boolean> {
  let value: unknown
  try {
    value = JSON.parse(
      await readFile(completionMarkerPath(paths, lifecycleId), 'utf8'),
    )
  } catch {
    return false
  }
  return (
    typeof value === 'object' &&
    value !== null &&
    'lifecycleId' in value &&
    value.lifecycleId === lifecycleId
  )
}
async function consumeLifecycleCompletion(
  paths: LifecyclePaths,
  lifecycleId: string,
): Promise<boolean> {
  if (!(await readLifecycleCompletion(paths, lifecycleId))) return false
  await rm(completionMarkerPath(paths, lifecycleId), { force: true })
  try {
    await rmdir(paths.completionDirectory)
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT', 'ENOTEMPTY')) throw error
  }
  return true
}


async function writeLifecycleCompletion(
  paths: LifecyclePaths,
  lifecycleId: string,
): Promise<void> {
  await mkdir(paths.completionDirectory, { recursive: true })
  const marker = completionMarkerPath(paths, lifecycleId)
  const temporary = `${marker}.${process.pid}.${randomUUID()}`
  await writeFile(temporary, JSON.stringify({ lifecycleId }), {
    encoding: 'utf8',
    flag: 'wx',
  })
  await rename(temporary, marker)
}

async function clearRecognizedLifecycleCompletions(
  paths: LifecyclePaths,
): Promise<void> {
  let names: string[]
  try {
    names = await readdir(paths.completionDirectory)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return
    throw error
  }

  for (const name of names) {
    const match = /^([a-zA-Z0-9-]{16,128})\.json$/.exec(name)
    if (!match || !(await readLifecycleCompletion(paths, match[1]))) continue
    await rm(completionMarkerPath(paths, match[1]), { force: true })
  }
  try {
    await rmdir(paths.completionDirectory)
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT', 'ENOTEMPTY')) throw error
  }
}

async function waitForLifecycleCompletion(
  paths: LifecyclePaths,
  lifecycleId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await readLifecycleCompletion(paths, lifecycleId)) return
    await delay(50)
  }
  throw new Error(
    `Timed out waiting for Playwright lifecycle "${lifecycleId}" cleanup to complete.`,
  )
}

async function collectActionError(
  errors: unknown[],
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action()
  } catch (error) {
    errors.push(error)
  }
}

async function collectCleanupErrors(
  actions: readonly (() => Promise<void>)[],
): Promise<unknown[]> {
  const errors: unknown[] = []
  for (const action of actions) await collectActionError(errors, action)
  return errors
}


type StackLeases = {
  application: PlaywrightPortLease
  project: PlaywrightPortLease
}

async function recoverPriorStack(
  configuration: Pick<
    PlaywrightStackConfiguration,
    'applicationPort' | 'composeProject'
  >,
  paths: LifecyclePaths,
  down: () => Promise<void>,
): Promise<StackLeases> {
  let application: PlaywrightPortLease | undefined
  let project: PlaywrightPortLease | undefined
  try {
    project = await acquireProjectLease(configuration.composeProject)
    application = await acquirePortLease(configuration.applicationPort)

    await clearRecognizedLifecycleCompletions(paths)

    await down()
    await rm(paths.directory, { force: true, recursive: true })
    return { application, project }
  } catch (error) {
    const releaseErrors: unknown[] = []
    if (application)
      await collectActionError(releaseErrors, application.release)
    if (project) await collectActionError(releaseErrors, project.release)
    if (releaseErrors.length)
      throw new AggregateError(
        [error, ...releaseErrors],
        'Playwright startup recovery and lease release failed.',
        { cause: error },
      )
    throw error
  }
}

export async function recoverPlaywrightStackForTest(options: {
  composeDown: () => Promise<void>
  composeProject: string
  directory: string
  port: number
}): Promise<PlaywrightPortLease> {
  const leases = await recoverPriorStack(
    {
      applicationPort: options.port,
      composeProject: validateComposeProject(
        options.composeProject,
        'Playwright test Compose project',
      ),
    },
    lifecyclePathsForDirectory(options.directory),
    options.composeDown,
  )
  return {
    release: async () => {
      const errors = await collectCleanupErrors([
        leases.application.release,
        leases.project.release,
      ])
      if (errors.length)
        throw new AggregateError(errors, 'Playwright test lease release failed.')
    },
  }
}

export function playwrightViteArgumentsForTest(port: number): string[] {
  return [viteCli, '--port', String(port), '--strictPort']
}

type ViteExit = {
  code: number | null
  error?: unknown
  signal: NodeJS.Signals | null
}

type RunningVite = {
  child: ChildProcess
  exited: Promise<ViteExit>
  pid: number
}
export type RunningViteForTest = RunningVite
export type ViteExitForTest = ViteExit

/**
 * Spawns a detached process (its own group, so a kill reaches its children). With `log` named, both output streams
 * are still written to this process's own output and are appended to that file too: the recovery tier reads Studio's
 * log for a planted key.
 */
export async function spawnSupervisedProcessForTest(
  command: string,
  args: readonly string[],
  options: { cwd: string; log?: string | undefined },
): Promise<RunningVite> {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    detached: process.platform !== 'win32',
    env: process.env,
    stdio: options.log ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (options.log) {
    const appended = createWriteStream(options.log, { flags: 'a' })
    child.stdout?.pipe(process.stdout, { end: false })
    child.stdout?.pipe(appended, { end: false })
    child.stderr?.pipe(process.stderr, { end: false })
    child.stderr?.pipe(appended, { end: false })
    child.once('close', () => appended.end())
  }
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
  return { child, exited: exited.promise, pid: child.pid }
}

function spawnVite(configuration: PlaywrightStackConfiguration): Promise<RunningVite> {
  return spawnSupervisedProcessForTest(
    process.execPath,
    playwrightViteArgumentsForTest(configuration.applicationPort),
    { cwd: studioDirectory, log: process.env.FREE_PLAYWRIGHT_STUDIO_LOG },
  )
}

export type ViteSupervisorOutcome =
  | { type: 'teardown'; vite: RunningVite }
  | { type: 'exit'; exit: ViteExit }

/**
 * Keeps one Vite running until a teardown request or an exit. A restartable stack (`FREE_PLAYWRIGHT_RESTARTABLE=1`:
 * the recovery tier, whose specs SIGKILL Studio under an open page) spawns Vite again after a SIGKILL, on the same
 * port, and records the new PID; any other exit ends the web server as before.
 */
export async function superviseViteForTest(options: {
  spawn(): Promise<RunningVite>
  restartable: boolean
  recordVite(pid: number): Promise<void>
  teardown: Promise<void>
  /** Stops a Vite the supervisor spawned but cannot hand back (its lifecycle write failed), before it rethrows. */
  stop?(vite: RunningVite): Promise<void>
}): Promise<ViteSupervisorOutcome> {
  const record = async (vite: RunningVite) => {
    try {
      await options.recordVite(vite.pid)
    } catch (error) {
      await options.stop?.(vite).catch(() => undefined)
      throw error
    }
  }
  let vite = await options.spawn()
  await record(vite)
  const teardown = options.teardown.then(() => ({ type: 'teardown' as const }))
  for (;;) {
    const event = await Promise.race([
      vite.exited.then((exit) => ({ exit, type: 'exit' as const })),
      teardown,
    ])
    if (event.type === 'teardown') return { type: 'teardown', vite }
    if (!options.restartable || event.exit.signal !== 'SIGKILL') return { type: 'exit', exit: event.exit }
    vite = await options.spawn()
    await record(vite)
  }
}

/** The configured stack's lifecycle state: the wrapper's PID and the current Vite's, for a spec that kills Studio. */
export async function readPlaywrightLifecycleStateForTest(): Promise<{ vitePid?: number; wrapperPid: number }> {
  const snapshot = await readLifecycleState(lifecyclePaths({ composeProject: parseComposeProject('') }))
  if (!snapshot.exists || 'error' in snapshot)
    throw new Error('The Playwright stack has no readable lifecycle state.', { cause: 'error' in snapshot ? snapshot.error : undefined })
  return { vitePid: snapshot.state.vitePid, wrapperPid: snapshot.state.wrapperPid }
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

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForViteExit(
  vite: RunningVite,
  timeoutMs: number,
): Promise<boolean> {
  const { promise, resolve: resolveWait } = Promise.withResolvers<boolean>()
  const timer = setTimeout(() => resolveWait(false), timeoutMs)
  void vite.exited.then(() => {
    clearTimeout(timer)
    resolveWait(true)
  })
  return promise
}

function signalOwnedVite(vite: RunningVite, signal: NodeJS.Signals): void {
  if (childExited(vite.child)) return
  try {
    process.kill(-vite.pid, signal)
  } catch (error) {
    if (!hasErrorCode(error, 'ESRCH')) throw error
  }
}

async function stopOwnedVite(vite: RunningVite): Promise<void> {
  if (childExited(vite.child)) return

  if (process.platform === 'win32') {
    // ChildProcess.kill uses the process handle retained by Node, so it cannot
    // target an unrelated process after numeric PID reuse. Vite is spawned
    // directly rather than through a shell, so this owned process is the tree
    // root we need to terminate.
    const signalled = vite.child.kill('SIGTERM')
    if (await waitForViteExit(vite, shutdownTimeoutMs)) return
    if (!signalled)
      throw new Error('The owned Playwright Vite process could not be signalled.')
    throw new Error('The owned Playwright Vite process did not exit after termination.')
  }

  signalOwnedVite(vite, 'SIGTERM')
  if (await waitForViteExit(vite, shutdownTimeoutMs)) return
  signalOwnedVite(vite, 'SIGKILL')
  if (!(await waitForViteExit(vite, shutdownTimeoutMs)))
    throw new Error('The owned Playwright Vite process group did not exit after SIGKILL.')
}

async function cleanupOwnedStack(
  configuration: PlaywrightStackConfiguration,
  paths: LifecyclePaths,
  vite?: RunningVite,
): Promise<unknown[]> {
  const actions: (() => Promise<void>)[] = []
  if (vite) actions.push(() => stopOwnedVite(vite))
  actions.push(() => composeDown(configuration))
  const errors = await collectCleanupErrors(actions)
  if (!errors.length)
    await collectActionError(errors, () =>
      rm(paths.directory, { force: true, recursive: true }),
    )
  return errors
}

async function cleanupFailedStart(
  configuration: PlaywrightStackConfiguration,
  paths: LifecyclePaths,
  setupError: unknown,
  vite?: RunningVite,
): Promise<never> {
  const cleanupErrors = await cleanupOwnedStack(configuration, paths, vite)
  if (cleanupErrors.length)
    throw new AggregateError(
      [setupError, ...cleanupErrors],
      'The Playwright web server failed to start and its cleanup also failed.',
    )
  throw setupError
}

async function setupPlaywrightStack(): Promise<{
  applicationLease: PlaywrightPortLease
  configuration: PlaywrightStackConfiguration
  paths: LifecyclePaths
  projectLease: PlaywrightPortLease
}> {
  const configuration = readConfiguredStack()
  const paths = lifecyclePaths(configuration)
  const leases = await recoverPriorStack(configuration, paths, () =>
    composeDown(configuration),
  )

  try {
    await writeLifecycleState(paths, configuration.lifecycleId)
    await composeUp(configuration)
    await waitForHealthyOidc(configuration.oidcIssuer)
    await migrateDatabase(configuration.databaseUrl)
  } catch (setupError) {
    const cleanupErrors = await collectCleanupErrors([
      () => composeDown(configuration),
    ])
    if (!cleanupErrors.length)
      await collectActionError(cleanupErrors, () =>
        rm(paths.directory, { force: true, recursive: true }),
      )
    await collectActionError(cleanupErrors, leases.application.release)
    await collectActionError(cleanupErrors, leases.project.release)
    if (cleanupErrors.length)
      throw new AggregateError(
        [setupError, ...cleanupErrors],
        'Playwright stack setup failed and its cleanup also failed.',
        { cause: setupError },
      )
    throw setupError
  }

  return {
    applicationLease: leases.application,
    configuration,
    paths,
    projectLease: leases.project,
  }
}

async function runPlaywrightWebServer(
  configuration: PlaywrightStackConfiguration,
  paths: LifecyclePaths,
  applicationLease: PlaywrightPortLease,
): Promise<void> {
  let vite: RunningVite | undefined
  try {
    await applicationLease.release()
    vite = await spawnVite(configuration)
    await writeLifecycleState(paths, configuration.lifecycleId, vite.pid)
  } catch (setupError) {
    return cleanupFailedStart(configuration, paths, setupError, vite)
  }

  const requestAbort = new AbortController()
  const first = vite
  let handedOut = false
  let event: ViteSupervisorOutcome
  try {
    event = await superviseViteForTest({
      // The first Vite is already running and recorded; every later spawn is a real respawn.
      spawn: async () => {
        if (handedOut) return spawnVite(configuration)
        handedOut = true
        return first
      },
      restartable: process.env.FREE_PLAYWRIGHT_RESTARTABLE === '1',
      recordVite: async (pid) => {
        if (pid !== first.pid) await writeLifecycleState(paths, configuration.lifecycleId, pid)
      },
      teardown: waitForTeardownRequest(paths, configuration.lifecycleId, requestAbort.signal),
      stop: stopOwnedVite,
    })
  } catch (respawnError) {
    // A respawn that fails ends the web server like any other exit.
    requestAbort.abort()
    const cleanupErrors = await cleanupOwnedStack(configuration, paths)
    if (cleanupErrors.length)
      throw new AggregateError(
        [respawnError, ...cleanupErrors],
        'The Playwright Vite server could not be respawned and stack cleanup also failed.',
        { cause: respawnError },
      )
    throw respawnError
  }
  requestAbort.abort()

  if (event.type === 'teardown') {
    const cleanupErrors = await cleanupOwnedStack(configuration, paths, event.vite)
    if (!cleanupErrors.length)
      await collectActionError(cleanupErrors, () =>
        writeLifecycleCompletion(paths, configuration.lifecycleId),
      )
    if (cleanupErrors.length)
      throw new AggregateError(
        cleanupErrors,
        'The Playwright web-server wrapper could not complete requested cleanup.',
      )
    return
  }

  const serverError = describeViteExit(event.exit)
  const cleanupErrors = await cleanupOwnedStack(configuration, paths)
  if (cleanupErrors.length)
    throw new AggregateError(
      [serverError, ...cleanupErrors],
      'The Playwright Vite server failed and stack cleanup also failed.',
    )
  throw serverError
}

export async function startPlaywrightWebServer(): Promise<void> {
  const { applicationLease, configuration, paths, projectLease } =
    await setupPlaywrightStack()
  let operationError: unknown
  let operationFailed = false
  try {
    await runPlaywrightWebServer(configuration, paths, applicationLease)
  } catch (error) {
    operationError = error
    operationFailed = true
  }

  const releaseErrors: unknown[] = []
  await collectActionError(releaseErrors, projectLease.release)
  if (operationFailed) {
    if (releaseErrors.length)
      throw new AggregateError(
        [operationError, ...releaseErrors],
        'Playwright web-server cleanup and project lease release failed.',
      )
    throw operationError
  }
  if (releaseErrors.length)
    throw new AggregateError(
      releaseErrors,
      'The Playwright project lease could not be released.',
    )
}

async function tryAcquireProjectLease(
  composeProject: string,
): Promise<{ error?: unknown; lease?: PlaywrightPortLease }> {
  try {
    return { lease: await acquireProjectLease(composeProject) }
  } catch (error) {
    return { error }
  }
}

async function fallbackTeardown(
  paths: LifecyclePaths,
  lease: PlaywrightPortLease,
  down: () => Promise<void>,
): Promise<void> {
  const errors: unknown[] = []
  await collectActionError(errors, down)
  if (!errors.length)
    await collectActionError(errors, () =>
      rm(paths.directory, { force: true, recursive: true }),
    )
  await collectActionError(errors, lease.release)
  if (errors.length)
    throw new AggregateError(
      errors,
      'Playwright fallback teardown was incomplete; lifecycle state was preserved for recovery.',
    )
}

async function teardownConfiguredStack(options: {
  composeProject: string
  down: () => Promise<void>
  lifecycleId: string
  paths: LifecyclePaths
  timeoutMs: number
}): Promise<void> {
  if (await consumeLifecycleCompletion(options.paths, options.lifecycleId)) return

  let snapshot: LifecycleStateSnapshot
  try {
    snapshot = await readLifecycleState(options.paths)
  } catch (error) {
    snapshot = { error, exists: true }
  }

  let leaseAttempt = await tryAcquireProjectLease(options.composeProject)
  if (leaseAttempt.lease)
    return fallbackTeardown(options.paths, leaseAttempt.lease, options.down)

  let cooperationError: unknown
  if (
    snapshot.exists &&
    'state' in snapshot &&
    snapshot.state.lifecycleId === options.lifecycleId
  ) {
    try {
      await writeTeardownRequest(options.paths, options.lifecycleId)
      await waitForLifecycleCompletion(
        options.paths,
        options.lifecycleId,
        options.timeoutMs,
      )
      await consumeLifecycleCompletion(options.paths, options.lifecycleId)
      return
    } catch (error) {
      cooperationError = error
    }

    if (await consumeLifecycleCompletion(options.paths, options.lifecycleId)) return
    leaseAttempt = await tryAcquireProjectLease(options.composeProject)
    if (leaseAttempt.lease)
      return fallbackTeardown(options.paths, leaseAttempt.lease, options.down)
    if (await consumeLifecycleCompletion(options.paths, options.lifecycleId)) return
  }

  const errors = [leaseAttempt.error]
  if (cooperationError !== undefined) errors.unshift(cooperationError)
  else if (snapshot.exists && 'error' in snapshot) errors.unshift(snapshot.error)
  throw new AggregateError(
    errors,
    `The Playwright project lease for "${options.composeProject}" remains held; active or newly started stack state was preserved and fallback Compose teardown was refused.`,
  )
}

export async function teardownPlaywrightStackForTest(options: {
  composeDown: () => Promise<void>
  composeProject: string
  directory: string
  lifecycleId: string
  timeoutMs?: number
}): Promise<void> {
  return teardownConfiguredStack({
    composeProject: validateComposeProject(
      options.composeProject,
      'Playwright test Compose project',
    ),
    down: options.composeDown,
    lifecycleId: validateLifecycleId(options.lifecycleId),
    paths: lifecyclePathsForDirectory(options.directory),
    timeoutMs: options.timeoutMs ?? 1_000,
  })
}

export async function teardownPlaywrightStack(): Promise<void> {
  const configuration = readConfiguredStack()
  await teardownConfiguredStack({
    composeProject: configuration.composeProject,
    down: () => composeDown(configuration),
    lifecycleId: configuration.lifecycleId,
    paths: lifecyclePaths(configuration),
    timeoutMs: readinessTimeoutMs,
  })
}
