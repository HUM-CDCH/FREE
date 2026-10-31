import type { ClientBase } from 'pg'
import { ensureLoginRole, IDENTIFIER, KEI_ROLE, KEI_SCHEMA } from './kei-role.js'

export const STUDIO_ROLE = 'free_studio'
/** Studio's DBOS system schema (apps/studio/server/dbos.ts). */
export const STUDIO_SCHEMA = 'dbos'

/**
 * Studio serves researchers over HTTP, so its long-lived process (and the evaluation watcher) connects as a role that
 * uses FREE's data without administering it: no superuser, no database, role or schema creation, no DDL on the
 * migrated schemas and no membership of `kei` or `free_extraction_runtime`. Idempotent; runs as the administrative
 * role after the migrations and ensureKeiRole, on every Studio start.
 */
export async function ensureStudioRole(
  client: ClientBase,
  options: Readonly<{ password: string; role?: string; schema?: string; keiRole?: string; keiSchema?: string }>,
): Promise<void> {
  const role = options.role ?? STUDIO_ROLE
  const schema = options.schema ?? STUDIO_SCHEMA
  const keiRole = options.keiRole ?? KEI_ROLE
  const keiSchema = options.keiSchema ?? KEI_SCHEMA
  if (![role, schema, keiRole, keiSchema].every((name) => IDENTIFIER.test(name)))
    throw new Error('The Studio and kei roles and schemas must be plain lowercase identifiers.')
  await client.query('BEGIN')
  try {
    await ensureLoginRole(client, role, options.password, 'The password in DATABASE_URL', schema)

    // The domain tables, and the durable coordination tables Studio's repository writes directly. The
    // extraction_runtime routines stay kei's: their triggers fire without Studio holding EXECUTE.
    for (const domain of ['public', 'extraction_runtime']) {
      await client.query(`GRANT USAGE ON SCHEMA ${domain} TO ${role}`)
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${domain} TO ${role}`)
      await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${domain} TO ${role}`)
    }
    // Prisma Next checks the migrated contract marker on first use; only the migrations write it.
    await client.query(`GRANT USAGE ON SCHEMA prisma_contract TO ${role}`)
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA prisma_contract TO ${role}`)

    // Studio's DBOS migrates its own schema at every launch, so the role owns that schema and everything in it. An
    // earlier Studio ran as the administrative role: its objects (and their workflow history) change owner one by
    // one. Sequences a column owns follow their table.
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ${role}`)
    await client.query(`ALTER SCHEMA ${schema} OWNER TO ${role}`)
    // DBOS 5.1.10's first migration is `CREATE SCHEMA IF NOT EXISTS`, which PostgreSQL refuses without CREATE on the
    // database even when the schema exists. On a fresh schema this performs its first two migrations exactly as DBOS
    // writes them, the schema and its version table, so Studio's launch applies the rest.
    if ((await client.query(`SELECT to_regclass('${schema}.dbos_migrations') IS NULL AS fresh`)).rows[0].fresh) {
      await client.query(
        `CREATE TABLE ${schema}.dbos_migrations ("version" bigint not null, constraint "dbos_migrations_pkey" primary key ("version"))`,
      )
      await client.query(`INSERT INTO ${schema}.dbos_migrations ("version") VALUES (2)`)
    }
    const foreign = await client.query<{ statement: string }>(
      `SELECT format('ALTER %s %s OWNER TO %I', CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW'
           WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END, c.oid::regclass, $2::text) AS statement
         FROM pg_class c
        WHERE c.relnamespace = $1::text::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
          AND c.relowner <> $2::text::regrole
          AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                           AND c.relkind = 'S' AND d.deptype IN ('a', 'i'))
       UNION ALL
       SELECT format('ALTER ROUTINE %s OWNER TO %I', p.oid::regprocedure, $2::text)
         FROM pg_proc p
        WHERE p.pronamespace = $1::text::regnamespace AND p.prokind IN ('f', 'p') AND p.proowner <> $2::text::regrole`,
      [schema, role],
    )
    for (const { statement } of foreign.rows) await client.query(statement)

    // Studio enqueues, reads, cancels and deletes kei's workflows in kei_dbos (spec, *Ownership*); kei migrates that
    // schema itself after Studio is healthy, so the default privileges reach the objects it creates later.
    await client.query(`GRANT USAGE ON SCHEMA ${keiSchema} TO ${role}`)
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${keiSchema} TO ${role}`)
    await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${keiSchema} TO ${role}`)
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${keiSchema} TO ${role}`)
    const defaults = `ALTER DEFAULT PRIVILEGES FOR ROLE ${keiRole} IN SCHEMA ${keiSchema} GRANT`
    await client.query(`${defaults} SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`)
    await client.query(`${defaults} USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`)
    await client.query(`${defaults} EXECUTE ON FUNCTIONS TO ${role}`)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
