import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadStudioServerConfig } from './config.js'
import { startStudioServer } from './host.js'

export async function main(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await startStudioServer(loadStudioServerConfig(environment))
}

/**
 * Starts Studio from the command line. A Studio that failed to start exits non-zero, so Compose restarts it: an open
 * pool or a launched DBOS (its queue runner and recovery) would otherwise keep a process without a listener alive.
 */
export async function runStudio(
  start: () => Promise<void> = main,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  try {
    await start()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    exit(1)
  }
}

const entryPath = process.argv[1]
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href
)
  void runStudio()
