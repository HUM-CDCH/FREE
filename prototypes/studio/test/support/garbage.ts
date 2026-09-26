import { lstat, readdir, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'

function disposableSchema(schema: string): void {
  if (!/^(dbos|kei_dbos)_t_[0-9a-f]{8}$/.test(schema))
    throw new Error('Garbage test support requires a disposable DBOS schema.')
}

/** Move only the completion time in a disposable system schema; updated_at still marks the boot boundary. */
export async function backdateWorkflow(url: string, schema: string, workflowId: string, byMs: number): Promise<void> {
  disposableSchema(schema)
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(`UPDATE "${schema}".workflow_status SET completed_at = completed_at - $1 WHERE workflow_uuid = $2`,
      [byMs, workflowId])
  } finally {
    await client.end()
  }
}

/** Age a test file or directory and all of its children. */
export async function ageFile(path: string, byMs: number): Promise<void> {
  const then = new Date(Date.now() - byMs)
  const info = await lstat(path)
  if (info.isDirectory()) for (const entry of await readdir(path)) await ageFile(join(path, entry), byMs)
  await utimes(path, then, then)
}

/** Count payload rows left after their workflow_status row was removed. */
export async function orphanPayloadRows(url: string, schema: string): Promise<number> {
  disposableSchema(schema)
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const { rows: tables } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = $1 AND column_name = 'workflow_uuid' AND table_name <> 'workflow_status'`,
      [schema])
    let orphans = 0
    for (const { table_name } of tables) {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*) FROM "${schema}"."${table_name}" t
         WHERE NOT EXISTS (SELECT 1 FROM "${schema}".workflow_status s WHERE s.workflow_uuid = t.workflow_uuid)`)
      orphans += Number(rows[0]!.count)
    }
    return orphans
  } finally {
    await client.end()
  }
}
