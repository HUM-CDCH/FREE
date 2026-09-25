import { DBOS } from '@dbos-inc/dbos-sdk'
import pg from 'pg'

// Each step records its own start/end in a probe table so the driver can see
// which steps ran before and after the kill.
const pool = new pg.Pool({ connectionString: process.env.M0R_DB_URL, max: 2 })

export async function ensureProbeTable(): Promise<void> {
  await pool.query(
    'create table if not exists lifecycle_step_runs(id bigserial primary key, workflow_id text not null, step text not null, pid int not null, at timestamptz not null default clock_timestamp())',
  )
}

async function mark(step: string): Promise<void> {
  await pool.query(
    'insert into lifecycle_step_runs(workflow_id, step, pid) values ($1, $2, $3)',
    [DBOS.workflowID, step, process.pid],
  )
}

async function lifecycleWorkFn(sleepMs: number): Promise<string> {
  await DBOS.runStep(() => mark('A'), { name: 'stepA' })
  // A native-style sleep inside a step: the step has no checkpoint until it
  // returns, so a kill here must re-run B (and only B) after recovery.
  await DBOS.runStep(
    async () => {
      await mark('B-start')
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
      await mark('B-end')
    },
    { name: 'stepB' },
  )
  await DBOS.runStep(() => mark('C'), { name: 'stepC' })
  return `done:${DBOS.workflowID}`
}

// Explicit name: the registration key cannot depend on what the bundler calls
// the function.
export const lifecycleWork = DBOS.registerWorkflow(lifecycleWorkFn, {
  name: 'lifecycleWork',
})

export async function closePool(): Promise<void> {
  await pool.end()
}
