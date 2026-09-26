import { pathToFileURL } from 'node:url'
import { DBOSClient } from '@dbos-inc/dbos-sdk'
import type { GarbageSummary } from '../api/_garbage_workflow.js'
import { COLLECT_GARBAGE_SCHEDULE, STUDIO_APPLICATION, STUDIO_SCHEMA } from './dbos.js'

/** Trigger the running Studio's schedule and wait for its result. This process never runs the workflow itself. */
export async function collectGarbageNow(databaseUrl: string, create = DBOSClient.create): Promise<{
  workflowId: string
  summary: GarbageSummary
}> {
  const client = await create({
    systemDatabaseUrl: databaseUrl,
    systemDatabaseSchemaName: STUDIO_SCHEMA,
    systemDatabasePoolSize: 1,
    applicationName: STUDIO_APPLICATION,
  })
  try {
    const handle = await client.triggerSchedule(COLLECT_GARBAGE_SCHEDULE)
    return { workflowId: handle.workflowID, summary: (await handle.getResult()) as GarbageSummary }
  } finally {
    await client.destroy()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL is required.')
    process.exit(2)
  }
  collectGarbageNow(databaseUrl).then(
    (result) => console.log(JSON.stringify(result)),
    (error: unknown) => {
      console.error(`collectGarbage failed: ${error instanceof Error ? error.name : 'unknown error'}`)
      process.exit(1)
    },
  )
}
