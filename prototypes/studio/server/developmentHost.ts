import type { ExtractionRuntime } from 'extraction'
import { normalizePath, type ViteDevServer } from 'vite'
import { relative } from 'node:path'

const RELOAD_COALESCE_MS = 50

type RunningExtractionRuntime = {
  instance: ExtractionRuntime
  abort: AbortController
  finished: Promise<void>
}

export type DevelopmentHost<T> = {
  composition(): Promise<T>
}

// Owns process-wide development state: the Extraction worker, the currently
// composed application, and adoption of changes in Vite's SSR module graph.
// The Vite plugin remains only the transport/composition adapter.
export async function createDevelopmentHost<T>(
  server: ViteDevServer,
  compose: () => Promise<T>,
): Promise<DevelopmentHost<T>> {
  let running: RunningExtractionRuntime | null = null
  let current: Promise<T> | null = null
  let reload: ReturnType<typeof setTimeout> | null = null

  const reportError = (error: unknown) => {
    server.config.logger.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    )
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
    current ??= startExtractionRuntime()
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
  server.httpServer?.once('close', () => {
    if (reload) clearTimeout(reload)
    void stopExtractionRuntime()
  })

  // Fail configuration before the server listens rather than on first use.
  await composition()
  return { composition }
}
