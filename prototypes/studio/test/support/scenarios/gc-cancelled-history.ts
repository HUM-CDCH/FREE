import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { createCanonicalPackageStore } from '../../../../../packages/db/src/artifact-store.js'
import { garbagePorts, type GarbageSummary } from '../../../api/_garbage_workflow.js'
import { listStagedSources, removeStagedSource } from '../../../api/_source_inbox.js'
import { databaseClockMs, launchStudioDbos, shutdownStudioDbos, studioDbos } from '../../../server/dbos.js'
import { applyStudioSchedules, registerStudioWorkflows } from '../../../server/workflows.js'
import { backdateWorkflow, orphanPayloadRows } from '../garbage.js'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`The GC history scenario needs ${name}.`)
  return value
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await delay(50)
  }
}

/** A cancelled-in-process GC history survives 60 days of age, then disappears on a new Studio boot. */
export async function run({ firstRun, env }: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  const url = required(env, 'DATABASE_URL')
  const schema = required(env, 'FREE_TEST_DBOS_SCHEMA')
  const root = required(env, 'FREE_TEST_INBOX')
  const observations = required(env, 'GC_OBSERVATIONS')
  const entered = required(env, 'GC_ENTERED')
  const release = required(env, 'GC_LATCH')
  const packages = createCanonicalPackageStore(required(env, 'FREE_TEST_PACKAGE_ROOT'))
  let holdFirstClock = firstRun
  await launchStudioDbos({
    databaseUrl: url, schema,
    keiSchema: required(env, 'FREE_TEST_KEI_SCHEMA'),
    executorId: required(env, 'FREE_TEST_EXECUTOR'),
    register: () => registerStudioWorkflows({ garbagePorts: () => garbagePorts({
      packages, inbox: { root, list: listStagedSources, remove: removeStagedSource },
      clock: async () => {
        if (holdFirstClock) {
          holdFirstClock = false
          writeFileSync(entered, 'inside clock step\n')
          await until(() => existsSync(release), 'release of cancelled clock step')
        }
        return databaseClockMs(url)
      },
    }) }),
    schedule: applyStudioSchedules,
  })
  try {
    if (firstRun) {
      const first = await DBOS.triggerSchedule('collectGarbage')
      await until(() => existsSync(entered), 'the first GC clock step')
      await studioDbos().admission.cancelWorkflow(first.workflowID)
      writeFileSync(release, 'release\n')
      await first.getResult().catch(() => undefined)
      await backdateWorkflow(url, schema, first.workflowID, 60 * 24 * 3600_000)
      const current = await (await DBOS.triggerSchedule('collectGarbage')).getResult() as GarbageSummary
      writeFileSync(observations, JSON.stringify({
        firstId: first.workflowID, currentDeleted: current.deletedStudioHistory,
        currentStatus: (await studioDbos().admission.getWorkflow(first.workflowID))?.status,
      }))
    } else {
      const before = JSON.parse(readFileSync(observations, 'utf8')) as {
        firstId: string; currentDeleted: number; currentStatus: string
      }
      const after = await (await DBOS.triggerSchedule('collectGarbage')).getResult() as GarbageSummary
      writeFileSync(observations, JSON.stringify({
        ...before, nextDeleted: after.deletedStudioHistory,
        nextStatus: (await studioDbos().admission.getWorkflow(before.firstId))?.status ?? null,
        orphanPayloads: await orphanPayloadRows(url, schema),
      }))
    }
  } finally {
    await shutdownStudioDbos()
  }
}
