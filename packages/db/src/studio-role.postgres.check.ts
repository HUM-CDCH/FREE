import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, test } from 'node:test'
import { Client } from 'pg'
import { ensureKeiRole } from './kei-role.js'
import { migrate, provisionDatabase } from './record-scope-history-fixture.js'
import { ensureStudioRole } from './studio-role.js'

/**
 * Studio's runtime role is PostgreSQL privilege behaviour, so only PostgreSQL can prove it. Roles are cluster-wide: the
 * check migrates its own free_test_* database and uses uniquely named roles and schemas, never `free_studio` or `kei`,
 * and drops them when it ends. apps/studio/server/runtime-role.postgres.test.ts drives Studio's own paths on the role.
 */
const base = process.env.PROJECT_STORE_POSTGRES_URL

test('Studio\'s runtime role uses the migrated data, owns only its DBOS schema, and administers nothing', async () => {
  if (!base) throw new Error('Set PROJECT_STORE_POSTGRES_URL to a disposable free_test_* database.')
  const suffix = randomBytes(4).toString('hex')
  const names = {
    role: `free_test_studio_${suffix}`, schema: `free_test_dbos_${suffix}`,
    keiRole: `free_test_kei_${suffix}`, keiSchema: `free_test_kei_dbos_${suffix}`, owner: `free_test_owner_${suffix}`,
  }
  const password = randomBytes(24).toString('hex'), keiPassword = randomBytes(24).toString('hex')
  const target = await provisionDatabase(base, `free_test_studio_role_${suffix}`)
  const admin = new Client({ connectionString: target.url })
  const connections: Client[] = [admin]
  after(async () => {
    const failures: unknown[] = []
    for (const connection of connections) await connection.end().catch((error: unknown) => failures.push(error))
    // The database holds every grant and default privilege, so the roles are unused once it is gone.
    await target.drop().catch((error: unknown) => failures.push(error))
    const maintenance = new URL(target.url)
    maintenance.pathname = '/postgres'
    const cluster = new Client({ connectionString: maintenance.toString() })
    await cluster.connect()
    try {
      for (const role of [names.role, names.keiRole, names.owner])
        await cluster.query(`DROP ROLE IF EXISTS ${role}`).catch((error: unknown) => failures.push(error))
    } finally {
      await cluster.end()
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Studio role check cleanup failed.')
  })
  await migrate(target.url)
  await admin.connect()
  const connect = async (role: string, secret: string) => {
    const url = new URL(target.url)
    url.username = role
    url.password = secret
    const client = new Client({ connectionString: url.toString() })
    connections.push(client)
    await client.connect()
    return client
  }
  const prepare = async () => {
    await ensureKeiRole(admin, { role: names.keiRole, schema: names.keiSchema, password: keiPassword })
    await ensureStudioRole(admin, { ...names, password })
  }

  await prepare()
  // A role someone granted extra privileges loses them at the next start, which changes nothing else: memberships,
  // and the direct grants checked as denied below, default privileges included.
  const database = new URL(target.url).pathname.slice(1)
  for (const sql of [
    `GRANT pg_read_all_data TO ${names.role}`,
    `GRANT CREATE ON DATABASE "${database}" TO ${names.role}, ${names.keiRole}`,
    `GRANT CREATE ON SCHEMA public, extraction_runtime, prisma_contract, ${names.keiSchema} TO ${names.role}`,
    `GRANT TRUNCATE, TRIGGER, REFERENCES ON public."projectContext" TO ${names.role}`,
    `GRANT INSERT, UPDATE, DELETE ON prisma_contract.marker TO ${names.role}`,
    `GRANT EXECUTE ON FUNCTION extraction_runtime.content_hash(jsonb) TO ${names.role}, ${names.keiRole}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO ${names.role}`,
    `GRANT USAGE ON SCHEMA public, ${names.schema} TO ${names.keiRole}`,
    `GRANT SELECT ON public."projectContext", ${names.schema}.dbos_migrations, extraction_runtime.head TO ${names.keiRole}`,
  ]) await admin.query(sql)
  await prepare()
  await admin.query('CREATE TABLE public.later_migration (id int)') // a table a later migration adds
  const role = (await admin.query(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls,
    rolcanlogin, (SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid) AS memberships
    FROM pg_roles r WHERE rolname = $1`, [names.role])).rows[0]
  assert.deepEqual(role, { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false,
    rolreplication: false, rolbypassrls: false, rolcanlogin: true, memberships: 0 })
  assert.equal((await admin.query('SELECT has_database_privilege($1, current_database(), \'CREATE\') AS ok', [names.role])).rows[0].ok, false)
  // A runtime URL naming the administrator never demotes it.
  await assert.rejects(ensureStudioRole(admin, { ...names, role: 'postgres', password }), /Refusing to restrict postgres/)
  assert.equal((await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname = \'postgres\'')).rows[0].rolsuper, true)
  // An owner keeps its object's DDL whatever is revoked, so a role owning a migrated table, or this database, is
  // refused and left as it was rather than presented as restricted.
  // Its own schema may not exist yet, on a first start.
  for (const owned of [`TABLE public."evaluationRound"`, `DATABASE "${database}"`, 'SCHEMA extraction_runtime']) {
    await admin.query(`CREATE ROLE ${names.owner} NOLOGIN`)
    await admin.query(`ALTER ${owned} OWNER TO ${names.owner}`)
    await assert.rejects(ensureStudioRole(admin, { ...names, role: names.owner, schema: `free_test_absent_${suffix}`, password }),
      /owns objects outside/, owned)
    assert.equal((await admin.query('SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [names.owner])).rows[0].rolcanlogin, false)
    await admin.query(`ALTER ${owned} OWNER TO postgres`)
    await admin.query(`DROP ROLE ${names.owner}`)
  }
  // A privilege only its grantor can revoke, or one PUBLIC holds where a fresh FREE database grants PUBLIC none, is
  // refused rather than claimed revoked.
  for (const [grant, revoke, prepareRole, reason] of [
    [`GRANT CREATE ON DATABASE "${database}" TO PUBLIC`, `REVOKE CREATE ON DATABASE "${database}" FROM PUBLIC`,
      () => ensureStudioRole(admin, { ...names, password }), /it can create schemas in this database/],
    ['GRANT SELECT ON extraction_runtime.head TO PUBLIC', 'REVOKE SELECT ON extraction_runtime.head FROM PUBLIC',
      () => ensureKeiRole(admin, { role: names.keiRole, schema: names.keiSchema, password: keiPassword }),
      /PUBLIC holds SELECT on extraction_runtime\.head/],
    ['GRANT EXECUTE ON FUNCTION extraction_runtime.content_hash(jsonb) TO PUBLIC',
      'REVOKE EXECUTE ON FUNCTION extraction_runtime.content_hash(jsonb) FROM PUBLIC',
      () => ensureStudioRole(admin, { ...names, password }), /PUBLIC can execute extraction_runtime\.content_hash\(jsonb\)/],
    [`CREATE ROLE ${names.owner} NOLOGIN; GRANT USAGE ON SCHEMA prisma_contract TO ${names.owner} WITH GRANT OPTION;
      SET ROLE ${names.owner}; GRANT USAGE ON SCHEMA prisma_contract TO ${names.keiRole}; RESET ROLE`,
      `REVOKE USAGE ON SCHEMA prisma_contract FROM ${names.owner} CASCADE; DROP ROLE ${names.owner}`,
      () => ensureKeiRole(admin, { role: names.keiRole, schema: names.keiSchema, password: keiPassword }),
      /it still holds a privilege on schema prisma_contract/],
    // A default privilege reaches objects created after preparation, whoever grants it, a global one included.
    [`CREATE ROLE ${names.owner} NOLOGIN; GRANT CREATE ON SCHEMA extraction_runtime TO ${names.owner};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${names.owner} IN SCHEMA extraction_runtime GRANT SELECT ON TABLES TO PUBLIC`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${names.owner} IN SCHEMA extraction_runtime REVOKE ALL ON TABLES FROM PUBLIC;
      REVOKE CREATE ON SCHEMA extraction_runtime FROM ${names.owner}; DROP ROLE ${names.owner}`,
      () => ensureKeiRole(admin, { role: names.keiRole, schema: names.keiSchema, password: keiPassword }),
      /PUBLIC is granted SELECT on new tables that free_test_owner_\w+ creates in schema extraction_runtime/],
    // Neither the role nor its own schema may exist yet, on a first start.
    ['ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT USAGE ON SEQUENCES TO PUBLIC',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE USAGE ON SEQUENCES FROM PUBLIC',
      () => ensureStudioRole(admin, { ...names, role: names.owner, schema: `free_test_absent_${suffix}`, password }),
      /PUBLIC is granted USAGE on new sequences that postgres creates\./],
    ['ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT CREATE ON SCHEMAS TO PUBLIC',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE CREATE ON SCHEMAS FROM PUBLIC',
      () => ensureKeiRole(admin, { role: names.keiRole, schema: names.keiSchema, password: keiPassword }),
      /PUBLIC is granted CREATE on new schemas that postgres creates/],
    ['ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA extraction_runtime GRANT EXECUTE ON FUNCTIONS TO PUBLIC',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA extraction_runtime REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
      () => ensureStudioRole(admin, { ...names, password }),
      /PUBLIC is granted EXECUTE on new routines that postgres creates in schema extraction_runtime/],
  ] as const) {
    await admin.query(grant)
    await assert.rejects(prepareRole(), reason, grant)
    await admin.query(revoke)
  }
  // kei may give away what it creates in its own schema, but PUBLIC includes Studio: a default privilege there refuses
  // Studio, before kei has created any table.
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = $1::regnamespace',
    [names.keiSchema])).rows[0].n, 0)
  const keiDefaults = `ALTER DEFAULT PRIVILEGES FOR ROLE ${names.keiRole} IN SCHEMA ${names.keiSchema}`
  await admin.query(`${keiDefaults} GRANT ALL ON TABLES TO PUBLIC`)
  await ensureKeiRole(admin, { role: names.keiRole, schema: names.keiSchema, password: keiPassword })
  await assert.rejects(ensureStudioRole(admin, { ...names, password }),
    /PUBLIC is granted .*TRUNCATE.* on new tables that free_test_kei_\w+ creates in schema free_test_kei_dbos_\w+/)
  await admin.query(`${keiDefaults} REVOKE ALL ON TABLES FROM PUBLIC`)
  // Elsewhere, routine EXECUTE and type USAGE are PostgreSQL's built-in defaults for PUBLIC, and schema USAGE alone
  // neither creates objects nor reaches tables, so these default privileges are allowed.
  for (const sql of [
    'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC',
    'ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT USAGE ON TYPES TO PUBLIC',
    'ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT USAGE ON SCHEMAS TO PUBLIC',
    `${keiDefaults} GRANT EXECUTE ON FUNCTIONS TO PUBLIC`,
  ]) await admin.query(sql)
  await prepare()

  // kei migrates its schema after Studio's preparation: what it creates later is still Studio's to use.
  const kei = await connect(names.keiRole, keiPassword)
  await kei.query(`CREATE TABLE ${names.keiSchema}.workflow_status (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, status text)`)
  await kei.query(`CREATE FUNCTION ${names.keiSchema}.probe() RETURNS int LANGUAGE sql AS 'SELECT 1'`)

  const studio = await connect(names.role, password)
  await studio.query(`INSERT INTO ${names.keiSchema}.workflow_status (status) VALUES ('ENQUEUED')`)
  await studio.query(`UPDATE ${names.keiSchema}.workflow_status SET status = 'CANCELLED'`)
  assert.equal((await studio.query(`SELECT ${names.keiSchema}.probe() AS one`)).rows[0].one, 1)
  await studio.query(`DELETE FROM ${names.keiSchema}.workflow_status`)
  // Its own DBOS schema, the domain tables, the durable coordination tables and the contract marker.
  await studio.query(`CREATE TABLE ${names.schema}.probe (id int)`)
  await studio.query(`CREATE FUNCTION ${names.schema}.noop() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NULL; END'`)
  assert.equal((await studio.query(`SELECT version FROM ${names.schema}.dbos_migrations`)).rows[0].version, '2')
  await studio.query('SELECT count(*) FROM public."projectContext"')
  await studio.query('SELECT count(*) FROM extraction_runtime.head')
  await studio.query('SELECT count(*) FROM prisma_contract.marker')
  const owners = (await admin.query(`SELECT DISTINCT pg_get_userbyid(relowner) AS owner FROM pg_class
    WHERE relnamespace = $1::regnamespace`, [names.schema])).rows.map((row) => row.owner)
  assert.deepEqual(owners, [names.role])

  for (const sql of [
    'CREATE DATABASE free_test_studio_role_denied',
    'CREATE ROLE free_test_studio_role_denied',
    'SET ROLE postgres', `SET ROLE ${names.keiRole}`, 'SET ROLE free_extraction_runtime',
    'CREATE SCHEMA free_test_studio_role_denied',
    'CREATE TABLE public.studio_probe (id int)',
    'ALTER TABLE public."projectContext" ADD COLUMN probe int',
    'DROP TABLE public."evaluationRound"',
    'TRUNCATE public."projectContext" CASCADE',
    'TRUNCATE public.later_migration',
    `CREATE TRIGGER probe BEFORE INSERT ON public."projectContext" FOR EACH ROW EXECUTE FUNCTION ${names.schema}.noop()`,
    'CREATE TABLE extraction_runtime.studio_probe (id int)',
    'ALTER TABLE extraction_runtime.head DISABLE TRIGGER USER',
    `CREATE TABLE ${names.keiSchema}.studio_probe (id int)`,
    `ALTER TABLE ${names.keiSchema}.workflow_status ADD COLUMN probe int`,
    `TRUNCATE ${names.keiSchema}.workflow_status`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${names.keiRole} GRANT ALL ON TABLES TO ${names.role}`,
    'DELETE FROM prisma_contract.marker',
    'CREATE TABLE prisma_contract.studio_probe (id int)',
    'SELECT extraction_runtime.capabilities()',
    'SELECT extraction_runtime.content_hash(\'{}\'::jsonb)',
  ])
    await assert.rejects(studio.query(sql), (error: { code?: string }) => error.code === '42501', sql)

  // kei still sees nothing of Studio's: neither its tables nor its DBOS schema, nor a routine off its allowlist.
  for (const sql of [
    'SELECT count(*) FROM public."projectContext"',
    'SELECT count(*) FROM extraction_runtime.head',
    `SELECT count(*) FROM ${names.schema}.dbos_migrations`,
    'SELECT extraction_runtime.content_hash(\'{}\'::jsonb)',
    'SELECT extraction_runtime.authorized(gen_random_uuid(), gen_random_uuid(), 0)',
    `CREATE SCHEMA free_test_kei_denied_${suffix}`,
  ])
    await assert.rejects(kei.query(sql), (error: { code?: string }) => error.code === '42501', sql)
  assert.ok((await kei.query('SELECT extraction_runtime.capabilities() AS v')).rows[0].v)
})
