import { appendFileSync } from 'node:fs'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { launchStudioDbos, shutdownStudioDbos, STUDIO_QUEUE, studioDbos } from '../../../server/dbos.js'
import { awaitWorkflowOutcome } from '../../../server/workflowOutcome.js'
import { requiredScenarioValue } from '../scenarioEnvironment.js'

const WORKFLOW_NAME = 'lifecycleProbe'
const WORKFLOW_ID = 'lifecycle-probe'

// Set before launch; the first run dies inside step b.
let crashInStepB = false

async function probe(file: string): Promise<void> {
  await DBOS.runStep(async () => appendFileSync(file, 'a\n'), { name: 'a' })
  await DBOS.runStep(
    async () => {
      appendFileSync(file, 'b-start\n')
      if (crashInStepB) process.kill(process.pid, 'SIGKILL')
      appendFileSync(file, 'b-end\n')
    },
    { name: 'b' },
  )
  await DBOS.runStep(async () => appendFileSync(file, 'c\n'), { name: 'c' })
}

/** First run: enqueue the probe and die in step b. Second run: recovery finishes it; wait, then shut down. */
export async function run({ firstRun, env }: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  const required = requiredScenarioValue(env, 'lifecycle')
  crashInStepB = firstRun
  const file = required('FREE_TEST_LIFECYCLE_FILE')
  const databaseUrl = required('DATABASE_URL')
  await launchStudioDbos({
    databaseUrl,
    keiDatabaseUrl: env.FREE_KEI_QUEUE_DATABASE_URL ?? databaseUrl,
    schema: required('FREE_TEST_DBOS_SCHEMA'),
    keiSchema: required('FREE_TEST_KEI_SCHEMA'),
    executorId: required('FREE_TEST_EXECUTOR'),
    register: () => {
      DBOS.registerWorkflow(probe, { name: WORKFLOW_NAME })
    },
  })
  if (firstRun)
    await studioDbos().admission.enqueue(
      { queueName: STUDIO_QUEUE, workflowName: WORKFLOW_NAME, workflowID: WORKFLOW_ID },
      file,
    )
  // The first run never gets past this wait: step b kills the process.
  const outcome = await awaitWorkflowOutcome(studioDbos().admission, WORKFLOW_ID, { timeoutMs: 60_000 })
  await shutdownStudioDbos()
  if (outcome.state !== 'finished') throw new Error(`${WORKFLOW_NAME} ended ${JSON.stringify(outcome)}.`)
}
