import { DBOS } from '@dbos-inc/dbos-sdk'
import { closePool, ensureProbeTable, lifecycleWork } from './workflows.js'
import { unnamedJob } from './collide-a.js'
import { namedJob } from './collide-b.js'

export function report(event: string, data: unknown = {}): void {
  console.log(`M0R ${JSON.stringify({ event, ...(data as object) })}`)
}

// The one place DBOS is configured and launched in this process.
export async function launchDbos(): Promise<void> {
  const url = process.env.M0R_DB_URL
  if (!url || !/^postgresql:\/\/[^@]+@127\.0\.0\.1:5432\/free_test_m0r_/.test(url))
    throw new Error('M0R_DB_URL must name a loopback free_test_m0r_* database')
  DBOS.setConfig({
    name: 'm0r-lifecycle',
    applicationVersion: 'm0r@1',
    executorID: 'local',
    systemDatabaseUrl: url,
    logLevel: 'error',
    enableOTLP: false,
  })
  await ensureProbeTable()
  await DBOS.launch()
  report('launched', { pid: process.pid, runtime: process.env.M0R_RUNTIME })

  // Second launch in the same process: refused or silently ignored?
  let secondLaunch: string
  try {
    await DBOS.launch()
    secondLaunch = 'resolved (no error)'
  } catch (error) {
    secondLaunch = `threw ${(error as Error).constructor.name}: ${(error as Error).message.split('\n')[0]}`
  }
  report('second-launch', { secondLaunch })
}

export async function startScenario(workflowID: string, sleepMs: number): Promise<void> {
  // Record the registered names of two same-named functions.
  const a = await DBOS.startWorkflow(unnamedJob, { workflowID: `${workflowID}:unnamed` })()
  const b = await DBOS.startWorkflow(namedJob, { workflowID: `${workflowID}:named` })()
  await a.getResult()
  await b.getResult()
  const statuses = await Promise.all([a.getStatus(), b.getStatus()])
  report('registered-names', {
    unnamed: statuses[0]?.workflowName,
    named: statuses[1]?.workflowName,
  })
  await DBOS.startWorkflow(lifecycleWork, { workflowID })(sleepMs)
  report('started', { workflowID })
}

export async function awaitRecovered(workflowID: string): Promise<void> {
  const handle = DBOS.retrieveWorkflow<string>(workflowID)
  const result = await handle.getResult()
  report('recovered-result', { workflowID, result, status: (await handle.getStatus())?.status })
}

export async function shutdownDbos(): Promise<void> {
  await DBOS.shutdown()
  await closePool()
}
