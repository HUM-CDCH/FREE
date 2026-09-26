import { setTimeout as delay } from 'node:timers/promises'
import { DBOS, DBOSClient, type DBOSConfig } from '@dbos-inc/dbos-sdk'
import { KEI_APPLICATION } from 'extraction/kei-handoff'
import pg from 'pg'

export const STUDIO_APPLICATION = 'studio'
export const STUDIO_SCHEMA = 'dbos'
/** Fixed: a change to a workflow's step sequence uses DBOS.patch(); a new version only after draining (spec, *Versions*). */
export const STUDIO_VERSION = 'studio@1'
/** Recovery takes PENDING rows of the same executor and version only (M0R 2), and Studio is one process. */
export const STUDIO_EXECUTOR = 'studio'
export const STUDIO_QUEUE = 'studio'
export const SUGGEST_QUEUE = 'suggest'
export const KEI_SCHEMA = 'kei_dbos'
/**
 * DBOS's own system-database pool. It holds one connection for LISTEN, lends up to three to queue dispatch and leaves
 * the rest for workflow and step checkpoints. One Studio process opens at most 21 connections: the domain pool
 * (packages/db, pg's default of 10) + this pool (5) + the admission client (2) + the kei client (4), plus one
 * short-lived connection that reads the boot clock.
 */
export const STUDIO_SYSTEM_POOL_SIZE = 5
const TERMINAL = new Set(['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'])

export type StudioDbosOptions = Readonly<{
  databaseUrl: string
  /** Registers every Studio workflow (registerStudioWorkflows); called once, before DBOS.launch(). */
  register: () => void
  /** Tests give each file its own system schemas and executor; production uses the defaults. */
  schema?: string
  keiSchema?: string
  executorId?: string
}>

export type StudioDbos = Readonly<{
  /** The database clock (ms since the epoch) read before launch, after the previous Studio process exited. M6 deletes
   *  cancelled Studio history only when it was updated before this (spec, *Cancelled Studio history*). */
  bootTimestampMs: number
  /** Enqueues Studio's own workflows by name: in a caller's transaction for row-backed admission, or not. */
  admission: DBOSClient
  /** Enqueues, reads and cancels kei's workflows in kei_dbos. It never registers a queue: a client's registerQueue
   *  defaults to always_update and would overwrite kei's lane limits (spec, *Ownership*). */
  kei: DBOSClient
}>

export function studioDbosConfig(options: Pick<StudioDbosOptions, 'databaseUrl' | 'schema' | 'executorId'>): DBOSConfig {
  return {
    name: STUDIO_APPLICATION,
    systemDatabaseUrl: options.databaseUrl,
    systemDatabaseSchemaName: options.schema ?? STUDIO_SCHEMA,
    applicationVersion: STUDIO_VERSION,
    executorID: options.executorId ?? STUDIO_EXECUTOR,
    systemDatabasePoolSize: STUDIO_SYSTEM_POOL_SIZE,
    enablePatching: true,
    enableOTLP: false,
    logLevel: 'info',
  }
}

type LaunchRecord = { launching?: Promise<StudioDbos>; launched?: StudioDbos; stopping?: Promise<void> }

/**
 * The launch is process-wide, like DBOS itself. Vite evaluates this module afresh after an edit to it and on every
 * dev-server restart (which configures the new server before closing the old one), and each instance must find the one
 * launch instead of meeting its DBOS as a foreign one.
 */
const launch: LaunchRecord = ((globalThis as { [key: symbol]: LaunchRecord | undefined })[
  Symbol.for('free.studio.dbos')
] ??= {})

/**
 * Launches DBOS once per process. A second DBOS.launch() resolves silently and ignores its configuration, and a
 * workflow registered after launch throws (M0R 2), so this is the only launcher: a repeated call returns the first
 * launch, and a DBOS launched by anyone else is refused.
 */
export function launchStudioDbos(options: StudioDbosOptions): Promise<StudioDbos> {
  if (launch.stopping) return launch.stopping.then(() => launchStudioDbos(options))
  if (launch.launching) return launch.launching
  if (DBOS.isInitialized())
    throw new Error('DBOS was launched outside launchStudioDbos; Studio launches it once per process.')
  const launching = start(options)
  launch.launching = launching
  launching.catch(() => {
    if (launch.launching === launching) launch.launching = undefined
  })
  return launching
}

async function start(options: StudioDbosOptions): Promise<StudioDbos> {
  const bootTimestampMs = await databaseClockMs(options.databaseUrl)
  options.register()
  DBOS.setConfig(studioDbosConfig(options))
  const clients: DBOSClient[] = []
  try {
    // DBOS can dispatch recovered work during launch, before these queues are registered again. Client construction
    // opens no connection, so expose both clients before dispatch can build a workflow's ports.
    const admission = await DBOSClient.create({
      systemDatabaseUrl: options.databaseUrl,
      systemDatabaseSchemaName: options.schema ?? STUDIO_SCHEMA,
      systemDatabasePoolSize: 2, // a transactional enqueue writes through the caller's own client
      applicationName: STUDIO_APPLICATION,
    })
    clients.push(admission)
    const kei = await DBOSClient.create({
      // Studio's own role: kei's restricted role owns kei_dbos, and the database owner may use it. Creating a client
      // runs no query (client.js:68-71), so Studio starts before kei has migrated its schema.
      systemDatabaseUrl: options.databaseUrl,
      systemDatabaseSchemaName: options.keiSchema ?? KEI_SCHEMA,
      systemDatabasePoolSize: 4,
      applicationName: KEI_APPLICATION,
    })
    clients.push(kei)
    const dbos = { bootTimestampMs, admission, kei }
    launch.launched = dbos
    await DBOS.launch()
    // Queues live in the system database, so they are registered after launch.
    await DBOS.registerQueue(STUDIO_QUEUE, { minPollingIntervalMs: 100 }) // p50 ~55 ms dequeue, not ~0.5 s (M0R 3)
    await DBOS.registerQueue(SUGGEST_QUEUE, { globalConcurrency: 1 })
    return dbos
  } catch (error) {
    // Leave nothing running: a retry then launches afresh instead of meeting this DBOS as a foreign one. The startup
    // error is the one to report, so a failure while stopping is dropped.
    try {
      await stop(clients)
    } catch {
      // Report the startup failure.
    } finally {
      launch.launched = undefined
    }
    throw error
  }
}

/** Stops DBOS and closes the clients' pools, even when DBOS fails to stop. */
async function stop(clients: readonly DBOSClient[]): Promise<void> {
  try {
    await DBOS.shutdown()
  } finally {
    await Promise.all(clients.map((client) => client.destroy()))
  }
}

export function studioDbos(): StudioDbos {
  if (!launch.launched) throw new Error('Studio has not launched DBOS in this process.')
  return launch.launched
}

export function shutdownStudioDbos(): Promise<void> {
  if (launch.stopping) return launch.stopping
  const stopping = (async () => {
    const current = await launch.launching?.catch(() => undefined)
    try {
      if (current) await stop([current.admission, current.kei])
    } finally {
      launch.launching = undefined
      launch.launched = undefined
      launch.stopping = undefined
    }
  })()
  launch.stopping = stopping
  return stopping
}

export async function databaseClockMs(databaseUrl: string): Promise<number> {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const { rows } = await client.query<{ ms: string }>(
      'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms',
    )
    return Number(rows[0]!.ms)
  } finally {
    await client.end()
  }
}

export type AwaitedWorkflow<T> =
  | { state: 'finished'; output: T }
  | { state: 'stopped'; status: string }
  | { state: 'timed-out' }

/** Waits for a workflow without ClientHandle.getResult, which cannot time out and would keep polling after the caller
 *  gave up. Reads the status every `intervalMs` until it is terminal, the deadline passes or `signal` aborts; an abort
 *  rejects with the signal's reason whether it arrives before a read or between two. */
export async function awaitWorkflowOutcome<T>(
  client: Pick<DBOSClient, 'listWorkflows'>,
  workflowId: string,
  options: { timeoutMs: number; signal?: AbortSignal; intervalMs?: number; now?: () => number },
): Promise<AwaitedWorkflow<T>> {
  const now = options.now ?? Date.now
  const deadline = now() + options.timeoutMs
  for (;;) {
    options.signal?.throwIfAborted()
    const [status] = await client.listWorkflows({ workflowIDs: [workflowId], loadInput: false, loadOutput: true })
    if (!status) return { state: 'stopped', status: 'MISSING' }
    if (status.status === 'SUCCESS') return { state: 'finished', output: status.output as T }
    if (TERMINAL.has(status.status)) return { state: 'stopped', status: status.status }
    const remaining = deadline - now()
    if (remaining <= 0) return { state: 'timed-out' }
    await delay(Math.min(options.intervalMs ?? 500, remaining), undefined, { signal: options.signal }).catch(
      (error: unknown) => {
        // The timer rejects with a generic AbortError; report the caller's own reason instead.
        options.signal?.throwIfAborted()
        throw error
      },
    )
  }
}
