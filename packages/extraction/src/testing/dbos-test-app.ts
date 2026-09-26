/** Studio's DBOS application in a test process, launched as Studio launches it (prototypes/studio/server/dbos.ts):
 *  application `studio`, version `studio@1`, the `studio` queue with a 100 ms polling floor, and `runExtraction`
 *  registered before launch. Its system schema and executor are the test's own (`dbos_t_<hex>`, `studio-t-<hex>`), and
 *  an admission client implements ExtractionExecution as Studio's does (api/_extractions.ts).
 *
 *  Test-only: nothing in the runtime imports it. DBOS is one singleton per process, so a test file launches it once. */
import { randomBytes } from 'node:crypto'
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk'
import pg from 'pg'
import { LIVE_WORKFLOW_STATUSES, workflowStatusesOf } from 'db'
import type { ExtractionExecution } from '../dependencies.js'
import { keiExtractWorkflowId } from '../kei-handoff.js'
import { EXTRACTION_QUEUE, registerExtractionWorkflow, type ExtractionWorkflowPorts } from '../workflows.js'

export type DbosTestApp = Readonly<{
  /** Studio's system schema for this test process. */
  schema: string
  admission: DBOSClient
  execution: ExtractionExecution
  close(): Promise<void>
}>

export async function launchDbosTestApp(options: {
  databaseUrl: string
  /** Read at every workflow run, so a test can switch the kei it talks to. */
  ports: () => ExtractionWorkflowPorts
}): Promise<DbosTestApp> {
  if (DBOS.isInitialized()) throw new Error('This test process already runs a DBOS application.')
  const hex = randomBytes(4).toString('hex')
  const schema = `dbos_t_${hex}`
  registerExtractionWorkflow(options.ports)
  DBOS.setConfig({
    name: 'studio',
    systemDatabaseUrl: options.databaseUrl,
    systemDatabaseSchemaName: schema,
    applicationVersion: 'studio@1',
    executorID: `studio-t-${hex}`,
    enableOTLP: false,
    logLevel: 'error',
  })
  let admission: DBOSClient | undefined
  try {
    await DBOS.launch()
    await DBOS.registerQueue(EXTRACTION_QUEUE, { minPollingIntervalMs: 100 })
    admission = await DBOSClient.create({
      systemDatabaseUrl: options.databaseUrl,
      systemDatabaseSchemaName: schema,
      applicationName: 'studio',
    })
  } catch (error) {
    await DBOS.shutdown().catch(() => undefined)
    await dropSchema(options.databaseUrl, schema)
    throw error
  }
  const client = admission
  const execution: ExtractionExecution = {
    enqueue: async (transaction, workflow, input) => {
      await client.enqueueInTransaction(
        transaction,
        { ...workflow, attributes: { ...workflow.attributes }, workflowIDReusePolicy: 'reject' },
        input,
      )
    },
    statuses: workflowStatusesOf((input) => client.listWorkflows(input)),
    async cancel(extractionId) {
      const studioId = `extract:${extractionId}`
      const [studio] = await client.listWorkflows({ workflowIDs: [studioId], loadInput: false, loadOutput: false })
      if (studio && LIVE_WORKFLOW_STATUSES.has(studio.status)) await client.cancelWorkflow(studioId)
      await options.ports().kei.cancel(keiExtractWorkflowId(extractionId))
    },
  }
  return {
    schema,
    admission: client,
    execution,
    async close() {
      try {
        await DBOS.shutdown()
      } finally {
        try {
          await client.destroy()
        } finally {
          await dropSchema(options.databaseUrl, schema)
        }
      }
    },
  }
}

async function dropSchema(databaseUrl: string, schema: string): Promise<void> {
  if (!/^dbos_t_[0-9a-f]{8}$/.test(schema)) throw new Error(`Refusing to drop schema ${schema}.`)
  const admin = new pg.Client({ connectionString: databaseUrl })
  await admin.connect()
  try {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  } finally {
    await admin.end()
  }
}
