import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { awaitRecovered, launchDbos, report, shutdownDbos, startScenario } from './app.js'

// Mirrors Studio's server/index.ts: a Node HTTP host that launches DBOS once.
export async function main(): Promise<void> {
  await launchDbos()
  const mode = process.env.M0R_MODE ?? 'start'
  const workflowID = process.env.M0R_WORKFLOW_ID ?? 'lifecycle-1'
  if (mode === 'start') {
    const server = createServer((_request, response) => response.end('ok'))
    server.listen(0, '127.0.0.1')
    await startScenario(workflowID, Number(process.env.M0R_SLEEP_MS ?? 8000))
    // Stay up like a server until the driver kills this process.
  } else if (mode === 'recover') {
    await awaitRecovered(workflowID)
    await shutdownDbos()
    process.exit(0)
  }
}

const entryPath = process.argv[1]
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href)
  void main().catch((error: unknown) => {
    report('fatal', { message: error instanceof Error ? error.message : String(error) })
    process.exit(1)
  })
