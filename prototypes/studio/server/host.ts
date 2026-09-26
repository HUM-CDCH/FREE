import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import type { ServerType } from '@hono/node-server'
import { serve } from '@hono/node-server'
import { extractionRuntime } from '../api/_extraction_runtime.js'
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
import { registerStudioWorkflows } from './workflows.js'

export type StudioRuntime = {
  run(signal: AbortSignal): Promise<void>
  close(): Promise<void>
}

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
  runtime?: StudioRuntime
  serve?: typeof serve
  signals?: StudioSignalTarget
  logger?: Pick<Console, 'error' | 'log'>
  providerRuntime?: Pick<StudioRuntime, 'close'>
  identityProvider?: EntraIdentityProvider
  dbos?: StudioDbosLifecycle
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
  const runtime = dependencies.runtime ?? extractionRuntime
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
      }),
    shutdown: shutdownStudioDbos,
  }
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
  const runtimeAbort = new AbortController()
  let stopping: Promise<void> | undefined

  const stopForSignal = () => {
    void shutdown().catch((error: unknown) => {
      logger.error(error)
      signals.exitCode = 1
    })
  }
  signals.once('SIGINT', stopForSignal)
  signals.once('SIGTERM', stopForSignal)

  const running = runtime.run(runtimeAbort.signal).catch((error: unknown) => {
    if (!runtimeAbort.signal.aborted) {
      logger.error(error)
      signals.exitCode = 1
      stopForSignal()
    }
  })

  function shutdown(): Promise<void> {
    if (stopping) return stopping
    stopping = (async () => {
      signals.off('SIGINT', stopForSignal)
      signals.off('SIGTERM', stopForSignal)
      runtimeAbort.abort()
      // Requests still in flight may enqueue work, so DBOS stops only after the listener closed; a listener that fails
      // to close must not leave DBOS, the runtime or the providers running.
      try {
        await closeServer(server)
      } finally {
        await Promise.all([
          dbos.shutdown(),
          runtime.close().then(() => running),
          providerRuntime.close(),
        ])
      }
    })()
    return stopping
  }

  return { server, shutdown }
}
