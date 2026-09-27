import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import type { ServerType } from '@hono/node-server'
import { serve } from '@hono/node-server'
import { pool } from 'db'
import { providerRuntime as productionProviderRuntime } from '../api/_provider.js'
import { createStudioApp } from './app.js'
import {
  createRequestPeerVerifier,
  type StudioServerConfig,
} from './config.js'
import { launchStudioDbos, shutdownStudioDbos } from './dbos.js'
import {
  createMicrosoftEntraIdentityProvider,
  type EntraIdentityProvider,
} from './entraIdentityProvider.js'
import { createStaticClientHandler } from './static.js'
import { applyStudioSchedules, registerStudioWorkflows } from './workflows.js'

/** DBOS in this process: launched once before the listener opens, shut down after it closed. */
export type StudioDbosLifecycle = {
  launch(): Promise<unknown>
  shutdown(): Promise<void>
}

export type StudioSignalTarget = {
  exitCode?: number
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

export type StudioHostDependencies = {
  clientRoot?: string
  serve?: typeof serve
  signals?: StudioSignalTarget
  logger?: Pick<Console, 'error' | 'log'>
  providerRuntime?: { close(): Promise<void> }
  identityProvider?: EntraIdentityProvider
  dbos?: StudioDbosLifecycle
  /** Ends the domain pool (packages/db) once nothing can query it any more. */
  closeDatabase?: () => Promise<void>
}

export type RunningStudioHost = {
  server: ServerType
  shutdown(): Promise<void>
}

export function productionClientRoot(): string {
  return resolve(import.meta.dirname, '../client')
}

function requiredDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error("DATABASE_URL must name Studio's database.")
  return databaseUrl
}

function closeServer(server: ServerType): Promise<void> {
  const { promise, resolve: resolveClose, reject } =
    Promise.withResolvers<void>()
  server.close((error?: Error) => {
    if (error) reject(error)
    else resolveClose()
  })
  return promise
}

export async function startStudioServer(
  config: StudioServerConfig,
  dependencies: StudioHostDependencies = {},
): Promise<RunningStudioHost> {
  const serveApplication = dependencies.serve ?? serve
  const signals = dependencies.signals ?? process
  const logger = dependencies.logger ?? console
  const providerRuntime =
    dependencies.providerRuntime ?? productionProviderRuntime
  const clientRoot = dependencies.clientRoot ?? productionClientRoot()
  const dbos = dependencies.dbos ?? {
    launch: () =>
      launchStudioDbos({
        databaseUrl: requiredDatabaseUrl(),
        register: registerStudioWorkflows,
        schedule: applyStudioSchedules,
      }),
    shutdown: shutdownStudioDbos,
  }
  const closeDatabase = dependencies.closeDatabase ?? (() => pool.end())
  const identityProvider =
    dependencies.identityProvider ??
    createMicrosoftEntraIdentityProvider({
      tenantId: config.entra.tenantId,
      clientId: config.entra.clientId,
      certificateThumbprint: config.entra.certificateThumbprint,
      certificatePrivateKey: readFileSync(
        config.entra.certificatePath,
        'utf8',
      ),
    })
  const app = await createStudioApp({
    studioOrigin: config.studioOrigin,
    basePath: config.basePath,
    sessionSecret: config.sessionSecret,
    identityProvider,
    requestPeer: createRequestPeerVerifier(config),
    clientHandler: createStaticClientHandler(clientRoot, config.basePath),
  })
  // A failed launch fails startup: the healthcheck never passes, so nothing that waits for Studio starts.
  await dbos.launch()
  const server = serveApplication(
    {
      fetch: app.fetch,
      hostname: config.hostname,
      port: config.port,
    },
    ({ address, port }) => {
      logger.log(`FREE Studio listening on ${address}:${port}`)
    },
  )
  let stopping: Promise<void> | undefined

  const stopForSignal = () => {
    void shutdown().catch((error: unknown) => {
      logger.error(error)
      signals.exitCode = 1
    })
  }
  signals.once('SIGINT', stopForSignal)
  signals.once('SIGTERM', stopForSignal)

  function shutdown(): Promise<void> {
    if (stopping) return stopping
    stopping = (async () => {
      signals.off('SIGINT', stopForSignal)
      signals.off('SIGTERM', stopForSignal)
      // Requests still in flight may enqueue work, so DBOS stops only after the listener closed; a listener that fails
      // to close must not leave DBOS or the providers running. The domain pool ends last: a workflow step still
      // running while DBOS stops queries it, and a closed pool would fail it instead of leaving it to recovery.
      try {
        await closeServer(server)
      } finally {
        try {
          await Promise.all([dbos.shutdown(), providerRuntime.close()])
        } finally {
          await closeDatabase()
        }
      }
    })()
    return stopping
  }

  return { server, shutdown }
}
