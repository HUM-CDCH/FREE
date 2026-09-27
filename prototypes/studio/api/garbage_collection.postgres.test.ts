import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, pool, type GarbageReferences } from 'db'
import { createCanonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import { spawnKeiStandIn, type KeiStandInProcess } from 'extraction/kei-stand-in-client'
import { applyStudioSchedules, registerStudioWorkflows } from '../server/workflows.js'
import { launchStudioDbos, shutdownStudioDbos, studioDbos } from '../server/dbos.js'
import { collectGarbageNow } from '../server/collectGarbageNow.js'
import { disposableDatabaseUrl, dropSchemas, testSchemas } from '../test/support/postgres.js'
import { backdateWorkflow, orphanPayloadRows } from '../test/support/garbage.js'
import { garbagePorts, type GarbagePorts, type GarbageSummary } from './_garbage_workflow.js'
import { listStagedSources, removeStagedSource } from './_source_inbox.js'

const url = disposableDatabaseUrl()
const schemas = testSchemas()
const scratch = mkdtempSync(join(tmpdir(), 'free-garbage-'))
const overrides: { -readonly [P in keyof GarbagePorts]?: GarbagePorts[P] } = {
  packages: createCanonicalPackageStore(join(scratch, 'packages')),
  inbox: { root: join(scratch, 'inbox'), list: listStagedSources, remove: removeStagedSource },
}
let standIn: KeiStandInProcess

beforeAll(async () => {
  standIn = await spawnKeiStandIn({ databaseUrl: url, schema: schemas.keiSchema })
  await launchStudioDbos({
    databaseUrl: url, ...schemas,
    register: () => registerStudioWorkflows({ garbagePorts: () => garbagePorts(overrides) }),
    schedule: applyStudioSchedules,
  })
})

afterAll(async () => {
  try {
    await shutdownStudioDbos()
    await standIn?.stop()
  } finally {
    await dropSchemas(url, schemas.schema, schemas.keiSchema)
    await db.close()
    await pool.end()
    rmSync(scratch, { recursive: true, force: true })
  }
})

async function sweep(): Promise<{ workflowId: string; summary: GarbageSummary }> {
  const handle = await DBOS.triggerSchedule('collectGarbage')
  return { workflowId: handle.workflowID, summary: await handle.getResult() as GarbageSummary }
}

describe('garbage collection on PostgreSQL', () => {
  it('registers a no-backfill ten-minute schedule on the gc queue', async () => {
    const schedule = await DBOS.getSchedule('collectGarbage')
    expect(schedule).toMatchObject({
      scheduleName: 'collectGarbage', schedule: '*/10 * * * *', queueName: 'gc', automaticBackfill: false,
    })
    expect((await DBOS.listSchedules()).map((entry) => entry.scheduleName)).toEqual(['collectGarbage'])
  })

  it('returns a summary from a triggered sweep of an empty store', async () => {
    const { summary } = await sweep()
    expect(summary.failedPhases).toEqual([])
    expect(summary.keiRequest).toBeNull()
    expect(summary.deletedStudioHistory).toBe(0)
  })

  it('gc:now triggers through a separate DBOS client and receives the summary', async () => {
    const create = ((options: Parameters<typeof DBOSClient.create>[0]) =>
      DBOSClient.create({ ...options, systemDatabaseSchemaName: schemas.schema })) as typeof DBOSClient.create
    const result = await collectGarbageNow(url, create)
    expect(result.workflowId).toMatch(/^sched-collectGarbage-trigger-/)
    expect(result.summary.failedPhases).toEqual([])
  })

  it('a failed reference read cancels or deletes nothing, while file phases still run', async () => {
    const fail = async (): Promise<never> => { throw new Error('hidden connection details') }
    overrides.references = {
      scopes: fail, referencedPreprocessIds: fail, referencedPackages: async () => new Set<string>(),
      packageIsReferenced: async () => false,
    } satisfies GarbageReferences
    try {
      const { summary } = await sweep()
      expect(summary.failedPhases).toEqual(['repairCancellations', 'studioHistory', 'keiRunsAndHistory'])
      expect(summary.removedPackages).toBe(0)
      expect(summary.removedStagedSources).toBe(0)
    } finally {
      delete overrides.references
    }
    expect((await sweep()).summary.failedPhases).toEqual([])
  })

  it('deletes a sweep history after 24 hours without orphaning DBOS payload rows', async () => {
    const first = await sweep()
    await backdateWorkflow(url, schemas.schema, first.workflowId, 25 * 3600_000)
    const second = await sweep()
    expect(second.summary.deletedStudioHistory).toBeGreaterThanOrEqual(1)
    expect(await studioDbos().admission.getWorkflow(first.workflowId)).toBeUndefined()
    expect(await orphanPayloadRows(url, schemas.schema)).toBe(0)
  })
})
