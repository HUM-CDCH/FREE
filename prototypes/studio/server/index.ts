import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadStudioServerConfig } from './config.js'
import { startStudioServer } from './host.js'

export async function main(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await startStudioServer(loadStudioServerConfig(environment))
}

const entryPath = process.argv[1]
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href
)
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
