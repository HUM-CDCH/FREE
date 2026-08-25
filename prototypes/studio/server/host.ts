import { resolve } from 'node:path'
import type { ServerType } from '@hono/node-server'
import { serve } from '@hono/node-server'
import { extractionRuntime } from '../api/_extraction_runtime.js'
import { createStudioApp } from './app.js'
import {
  createClientAddressResolver,
  createRequestPeerVerifier,
  type StudioServerConfig,
} from './config.js'
import { createStaticClientHandler } from './static.js'

export type StudioRuntime = {
  run(signal: AbortSignal): Promise<void>
  close(): Promise<void>
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
}

export type RunningStudioHost = {
  server: ServerType
  shutdown(): Promise<void>
}

export function productionClientRoot(): string {
  return resolve(import.meta.dirname, '../client')
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
  const clientRoot = dependencies.clientRoot ?? productionClientRoot()
  const app = await createStudioApp({
    studioOrigin: config.studioOrigin,
    basePath: config.basePath,
    sessionSecret: config.sessionSecret,
    clientAddress: createClientAddressResolver(config),
    requestPeer: createRequestPeerVerifier(config),
    clientHandler: createStaticClientHandler(clientRoot, config.basePath),
  })
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
      await Promise.all([
        closeServer(server),
        runtime.close().then(() => running),
      ])
    })()
    return stopping
  }

  return { server, shutdown }
}
