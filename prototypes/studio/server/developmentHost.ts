import type { ExtractionRuntime } from 'extraction'
import { normalizePath, type ViteDevServer } from 'vite'
import { relative } from 'node:path'

const RELOAD_COALESCE_MS = 50

// A registered workflow keeps the module instances it was registered from, and
// the running DBOS the configuration and queues it launched with, so
// recomposition cannot adopt an edit to one of these.
const RESTART_MODULE =
  /(^|\/)(api\/_[a-z_]*_workflow\.ts|server\/(dbos|workflows)\.ts|packages\/extraction\/src\/workflows\.ts)$/

// Vite restarts a dev server by configuring the new server, whose host adopts
// the running DBOS, before it closes the old one. Only the newest configured
// host shuts DBOS down, and the record is process-global because each restart
// evaluates this module afresh.
const DBOS_OWNER = Symbol.for('free.studio.dbos.developmentHost')
const developmentProcess = globalThis as { [DBOS_OWNER]?: object }

// server/dbos.ts and server/workflows.ts as the SSR loader returns them. They
// are typed here, not imported: a native import would be a second module
// instance beside the SSR-loaded one, with launch state of its own.
type StudioDbosModule = {
  launchStudioDbos(options: {
    databaseUrl: string
    register: () => void
  }): Promise<unknown>
  shutdownStudioDbos(): Promise<void>
}
type StudioWorkflowsModule = { registerStudioWorkflows(): void }

type RunningExtractionRuntime = {
  instance: ExtractionRuntime
  abort: AbortController
  finished: Promise<void>
}

export type DevelopmentHost<T> = {
  composition(): Promise<T>
}

// Owns process-wide development state: DBOS, launched once per process, the
// Extraction worker, the currently composed application, and adoption of
// changes in Vite's SSR module graph. The Vite plugin remains only the
// transport/composition adapter.
export async function createDevelopmentHost<T>(
  server: ViteDevServer,
  compose: () => Promise<T>,
): Promise<DevelopmentHost<T>> {
  let dbos: StudioDbosModule | null = null
  let launched: Promise<void> | null = null
  let running: RunningExtractionRuntime | null = null
  let current: Promise<T> | null = null
  let reload: ReturnType<typeof setTimeout> | null = null

  const reportError = (error: unknown) => {
    server.config.logger.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    )
  }

  // Loads the DBOS modules once and launches before the first composition. A
  // failed launch fails that composition, so the dev server does not start.
  const launchDbos = () => {
    launched ??= (async () => {
      if (!server.httpServer) return
      const databaseUrl = process.env.DATABASE_URL
      if (!databaseUrl)
        throw new Error("DATABASE_URL must name Studio's database.")
      const dbosModule = (await server.ssrLoadModule(
        '/server/dbos.ts',
      )) as StudioDbosModule
      const workflows = (await server.ssrLoadModule(
        '/server/workflows.ts',
      )) as StudioWorkflowsModule
      dbos = dbosModule
      await dbosModule.launchStudioDbos({
        databaseUrl,
        register: workflows.registerStudioWorkflows,
      })
    })()
    return launched
  }

  const stopDbos = async () => {
    try {
      await dbos?.shutdownStudioDbos()
    } catch (error) {
      reportError(error)
    }
  }

  const stopExtractionRuntime = async () => {
    const stopping = running
    if (!stopping) return
    running = null
    stopping.abort.abort()
    try {
      await stopping.instance.close()
      await stopping.finished
    } catch (error) {
      reportError(error)
    }
  }

  const startExtractionRuntime = async () => {
    if (!server.httpServer) return
    const runtimeModule = await server.ssrLoadModule(
      '/api/_extraction_runtime.ts',
    )
    const instance: ExtractionRuntime = runtimeModule.extractionRuntime
    if (running?.instance === instance) return
    await stopExtractionRuntime()
    const abort = new AbortController()
    const finished = instance.run(abort.signal).catch((error) => {
      if (!abort.signal.aborted) reportError(error)
    })
    running = { instance, abort, finished }
  }

  const composition = () => {
    current ??= launchDbos()
      .then(startExtractionRuntime)
      .then(compose)
      .catch((error) => {
        // A module that failed to evaluate must not become permanent: the next
        // request or file change gets another composition attempt.
        current = null
        throw error
      })
    return current
  }

  const scheduleRecomposition = (file: string) => {
    const ssr = server.environments.ssr.moduleGraph
    const changed = normalizePath(file)
    if (!ssr.getModulesByFile(changed)) return
    if (RESTART_MODULE.test(changed))
      server.config.logger.warn(
        'A DBOS workflow module changed: restart Studio to run the new workflow code (Compose restarts it on every server edit).',
      )
    ssr.onFileChange(changed)
    current = null
    if (reload) clearTimeout(reload)
    reload = setTimeout(() => {
      reload = null
      composition()
        .then(() =>
          server.config.logger.info(
            `server reloaded ${relative(server.config.root, changed)}`,
            { timestamp: true },
          ),
        )
        .catch(reportError)
    }, RELOAD_COALESCE_MS)
  }

  const recompose = (file: string) => {
    try {
      scheduleRecomposition(file)
    } catch (error) {
      reportError(error)
    }
  }
  server.watcher.on('change', recompose)
  server.watcher.on('unlink', recompose)
  const host = {}
  server.httpServer?.once('close', () => {
    if (reload) clearTimeout(reload)
    void stopExtractionRuntime()
    if (developmentProcess[DBOS_OWNER] !== host) return
    delete developmentProcess[DBOS_OWNER]
    void stopDbos()
  })

  // Fail configuration before the server listens rather than on first use.
  await composition()
  // A restart that fails to configure leaves DBOS to the server that keeps running.
  if (server.httpServer) developmentProcess[DBOS_OWNER] = host
  return { composition }
}
