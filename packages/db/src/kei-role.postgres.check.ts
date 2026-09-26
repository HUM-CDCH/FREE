import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, test } from 'node:test'
import { Client } from 'pg'
import { validateDisposableTestDatabaseTarget } from './database-url.js'
import { ensureKeiRole } from './kei-role.js'

/**
 * kei's isolation is PostgreSQL privilege behaviour, so only PostgreSQL can prove it. Roles are cluster-wide: the check
 * uses a uniquely named role and schema so it never touches a real `kei`, and drops both when it ends.
 */
const databaseUrl = process.env.PROJECT_STORE_POSTGRES_URL

test('kei logs in with its own role, owns only kei_dbos, and is denied on public and dbos', async () => {
  if (!databaseUrl)
    throw new Error(
      'Set PROJECT_STORE_POSTGRES_URL to a disposable free_test_* database, for example: pnpm --filter db db:start && createdb free_test_kei_role.',
    )
  validateDisposableTestDatabaseTarget(databaseUrl)

  const suffix = randomBytes(4).toString('hex')
  const role = `free_test_kei_${suffix}`
  const schema = `free_test_kei_dbos_${suffix}`
  const password = randomBytes(24).toString('hex')

  const owner = new Client({ connectionString: databaseUrl })
  await owner.connect()
  let kei: Client | undefined
  after(async () => {
    const failures: unknown[] = []
    try {
      await kei?.end()
    } catch (error) {
      failures.push(error)
    }
    // Every statement runs even when an earlier one fails, so a leaked role never outlives the check.
    for (const sql of [
      `DROP SCHEMA IF EXISTS ${schema} CASCADE`,
      'DROP SCHEMA IF EXISTS dbos CASCADE',
      'DROP TABLE IF EXISTS public.kei_denial_probe',
      `DROP OWNED BY ${role}`,
      `DROP ROLE IF EXISTS ${role}`,
      'GRANT USAGE ON SCHEMA public TO PUBLIC',
    ]) {
      try {
        await owner.query(sql)
      } catch (error) {
        failures.push(error)
      }
    }
    await owner.end()
    if (failures.length > 0) throw new AggregateError(failures, 'kei role check cleanup failed.')
  })

  // Studio's DBOS schema arrives in M4. A schema the Studio role creates grants PUBLIC nothing; this stands in for it.
  await owner.query('CREATE SCHEMA IF NOT EXISTS dbos')
  await owner.query('CREATE TABLE IF NOT EXISTS dbos.workflow_status (workflow_uuid text PRIMARY KEY)')
  await owner.query('CREATE TABLE IF NOT EXISTS public.kei_denial_probe (id int)')
  await ensureKeiRole(owner, { role, schema, password })
  await ensureKeiRole(owner, { role, schema, password }) // a Studio restart runs it again

  const keiUrl = new URL(databaseUrl)
  keiUrl.username = role
  keiUrl.password = password
  kei = new Client({ connectionString: keiUrl.toString() })
  await kei.connect()

  for (const sql of [
    'SELECT count(*) FROM public.kei_denial_probe',
    'CREATE TABLE public.kei_probe (id int)',
    'SELECT count(*) FROM dbos.workflow_status',
    'CREATE TABLE dbos.kei_probe (id int)',
    `CREATE SCHEMA kei_other_${suffix}`,
  ])
    await assert.rejects(kei.query(sql), (error: { code?: string }) => error.code === '42501', sql)

  await kei.query(`CREATE TABLE ${schema}.probe (id int)`)
  await kei.query(`INSERT INTO ${schema}.probe VALUES (1)`)
})
