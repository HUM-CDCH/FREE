import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { canonicalPackageStore, createResearcherProjectStore } from 'db'
import { keiConvertWorkflowId } from 'extraction/kei-handoff'
import { createSourceDocumentIngestion } from '../../../api/source_documents.js'
import { stageSource, uploadSourcePath } from '../../../api/_source_inbox.js'
import { awaitWorkflowOutcome, launchStudioDbos, shutdownStudioDbos, studioDbos } from '../../../server/dbos.js'
import { applyStudioSchedules, registerStudioWorkflows } from '../../../server/workflows.js'
import { ageFile } from '../garbage.js'
import { uploadRequest } from '../ingestion.js'
import type { GarbageSummary } from '../../../api/_garbage_workflow.js'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`The held-ingestion GC scenario needs ${name}.`)
  return value
}

/** Recover an ingestion twice: its aged staged PDF remains while kei holds conversion, then disappears on success. */
export async function run({ firstRun, env }: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  const project = required(env, 'FREE_TEST_PROJECT')
  const observations = required(env, 'GC_OBSERVATIONS')
  const inbox = required(env, 'FREE_SOURCE_INBOX')
  await launchStudioDbos({
    databaseUrl: required(env, 'DATABASE_URL'),
    schema: required(env, 'FREE_TEST_DBOS_SCHEMA'),
    keiSchema: required(env, 'FREE_TEST_KEI_SCHEMA'),
    executorId: required(env, 'FREE_TEST_EXECUTOR'),
    register: registerStudioWorkflows,
    schedule: applyStudioSchedules,
  })
  if (firstRun) {
    const pdf = new Uint8Array(await readFile(required(env, 'FREE_TEST_PDF')))
    const ingest = createSourceDocumentIngestion(
      createResearcherProjectStore(required(env, 'FREE_TEST_ACCOUNT')),
      { resultTimeoutMs: 250, resultPollIntervalMs: 50 },
    )
    const responses = await Promise.all([ingest(uploadRequest(project, pdf)), ingest(uploadRequest(project, pdf))])
    if (responses.some((response) => response.status !== 504))
      throw new Error(`Expected both joined uploads to time out, got ${responses.map((r) => r.status).join(', ')}.`)
    process.kill(process.pid, 'SIGKILL')
    return
  }
  const [attempt] = await studioDbos().admission.listWorkflows({
    workflow_id_prefix: `ingest:${project}:`, loadInput: false, loadOutput: false,
  })
  if (!attempt) throw new Error('The held ingestion has no workflow.')
  const relative = uploadSourcePath(project, attempt.workflowID.split(':')[2]!)
  const file = join(inbox, relative)
  if (!existsSync(observations)) {
    const loserRelative = uploadSourcePath(project, randomUUID())
    const loser = join(inbox, loserRelative)
    await stageSource(inbox, loserRelative, new Uint8Array(await readFile(required(env, 'FREE_TEST_PDF'))))
    const childId = keiConvertWorkflowId(attempt.workflowID)
    const deadline = Date.now() + 60_000
    for (;;) {
      const [child] = await studioDbos().kei.listWorkflows({ workflowIDs: [childId], loadInput: false, loadOutput: false })
      if (child?.status === 'PENDING') break
      if (Date.now() > deadline) throw new Error('The recovered conversion did not reach kei.')
      await delay(50)
    }
    await ageFile(file, 48 * 3600_000)
    await ageFile(loser, 25 * 3600_000)
    const summary = await (await DBOS.triggerSchedule('collectGarbage')).getResult() as GarbageSummary
    writeFileSync(observations, JSON.stringify({
      heldStatus: attempt.status, keptFile: existsSync(file), removedLoser: !existsSync(loser),
      removedStagedSources: summary.removedStagedSources,
      keiRequest: summary.keiRequest, failedPhases: summary.failedPhases,
    }))
    process.kill(process.pid, 'SIGKILL')
    return
  }
  const outcome = await awaitWorkflowOutcome(studioDbos().admission, attempt.workflowID, { timeoutMs: 90_000 })
  const before = JSON.parse(readFileSync(observations, 'utf8')) as Record<string, unknown>
  writeFileSync(observations, JSON.stringify({ ...before, outcome: outcome.state, stagedAfter: existsSync(file),
    publishedPackages: (await canonicalPackageStore.list()).length }))
  await shutdownStudioDbos()
}
