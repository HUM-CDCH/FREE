import { existsSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { createCanonicalPackageStore } from '../../../../../packages/db/src/artifact-store.js'
import { garbagePorts, type GarbageSummary } from '../../../api/_garbage_workflow.js'
import { listStagedSources, removeStagedSource, stageSource, uploadSourcePath } from '../../../api/_source_inbox.js'
import { launchStudioDbos, shutdownStudioDbos } from '../../../server/dbos.js'
import { applyStudioSchedules, registerStudioWorkflows } from '../../../server/workflows.js'
import { ageFile } from '../garbage.js'
import { requiredScenarioValue, scenarioDbosOptions } from '../scenarioEnvironment.js'

/** Crash after staging, before admission; on the new boot collect only the 25-hour-old orphan. */
export async function run({ firstRun, env }: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  const required = requiredScenarioValue(env, 'GC staged-source')
  const root = required('FREE_TEST_INBOX')
  const project = required('FREE_TEST_PROJECT')
  const oldRelative = uploadSourcePath(project, required('FREE_TEST_OLD_ATTEMPT'))
  const youngRelative = uploadSourcePath(project, required('FREE_TEST_YOUNG_ATTEMPT'))
  if (firstRun) {
    const pdf = new Uint8Array(await readFile(required('FREE_TEST_PDF')))
    await stageSource(root, oldRelative, pdf)
    await stageSource(root, youngRelative, pdf)
    await ageFile(join(root, oldRelative), 25 * 3600_000)
    await ageFile(join(root, youngRelative), 23 * 3600_000)
    process.kill(process.pid, 'SIGKILL')
    return
  }
  const packages = createCanonicalPackageStore(required('FREE_TEST_PACKAGE_ROOT'))
  await launchStudioDbos({
    ...scenarioDbosOptions(required),
    register: () => registerStudioWorkflows({ garbagePorts: () => garbagePorts({
      packages, inbox: { root, list: listStagedSources, remove: removeStagedSource },
    }) }),
    schedule: applyStudioSchedules,
  })
  try {
    const summary = await (await DBOS.triggerSchedule('collectGarbage')).getResult() as GarbageSummary
    writeFileSync(required('GC_OBSERVATIONS'), JSON.stringify({
      summary, oldExists: existsSync(join(root, oldRelative)), youngExists: existsSync(join(root, youngRelative)),
    }))
  } finally {
    await shutdownStudioDbos()
  }
}
