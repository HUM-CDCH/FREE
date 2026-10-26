import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import type { ClientBase } from 'pg'

export const KEI_ROLE = 'kei'
export const KEI_SCHEMA = 'kei_dbos'
/** Explicit allowlist: internal authorization and hash helpers are never exposed. */
export const EXTRACTION_RUNTIME_ROUTINES = [
  'capabilities()', 'claim(uuid,uuid,uuid)', 'heartbeat(uuid,uuid,integer)',
  'publish_plan(uuid,uuid,integer,uuid,text,jsonb)',
  'capture_unit(uuid,uuid,integer,uuid,text,jsonb)',
  'finalize_input(uuid,uuid,integer,uuid,jsonb)', 'begin_call(uuid,uuid,integer,uuid)',
  'commit_output(uuid,uuid,integer,uuid,text,jsonb)', 'fail_call(uuid,uuid,integer,uuid)',
  'publish_snapshot(uuid,uuid,integer,uuid,uuid,jsonb,jsonb)',
  'acknowledge(uuid,uuid,integer,boolean,jsonb)',
  'resolve_selection(uuid,uuid,integer,jsonb)', 'read_call(uuid,uuid,integer,uuid)',
  'read_attempt_outcome(uuid,uuid)', 'historical_coverage(uuid,uuid,integer)', 'read_latest_snapshot(uuid,uuid,integer)',
  'read_deleted_graph(uuid,integer)',
] as const
/** Role and schema names are interpolated into SQL, so only plain lowercase identifiers are accepted. */
export const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

/** A SCRAM-SHA-256 verifier, so the plain password never reaches PostgreSQL or its logs. ASCII passwords only. */
export function scramSha256Verifier(password: string, salt = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

/** The pg_shdepend row `d` is not about `ownSchema` ($2) or an object in it, in this database. */
const OUTSIDE_OWN_SCHEMA = `NOT (d.dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND (
     (d.classid = 'pg_namespace'::regclass AND d.objid = coalesce(to_regnamespace($2)::oid, 0))
  OR (d.classid = 'pg_class'::regclass AND d.objid IN (SELECT oid FROM pg_class WHERE relnamespace = to_regnamespace($2)))
  OR (d.classid = 'pg_proc'::regclass AND d.objid IN (SELECT oid FROM pg_proc WHERE pronamespace = to_regnamespace($2)))
  OR (d.classid = 'pg_type'::regclass AND d.objid IN (SELECT oid FROM pg_type WHERE typnamespace = to_regnamespace($2)))
  OR (d.classid = 'pg_default_acl'::regclass
      AND d.objid IN (SELECT oid FROM pg_default_acl WHERE defaclnamespace = to_regnamespace($2)))))`

/**
 * Creates or updates a login role that holds no administrative attribute and no other role's privileges: no
 * superuser, database or role creation, replication or RLS bypass, NOINHERIT, and every membership revoked. The
 * password reaches PostgreSQL only as a SCRAM verifier. A superuser or the preparing role itself is refused, so a
 * misnamed role can never demote the administrator. So is a role that owns anything but `ownSchema` and what is in
 * it, in this database or another, or a database itself: an owner keeps its object's DDL whatever is revoked, and
 * this changes no owner. Every privilege granted to the role in this database outside `ownSchema` is then revoked,
 * except CONNECT and TEMPORARY on the database, for the caller to grant its allowlist again; a role still holding one
 * afterwards, or reaching outside its schema through PUBLIC, now or by a default privilege on objects created later, is
 * refused. Runs in the caller's transaction.
 */
export async function ensureLoginRole(
  client: ClientBase, role: string, password: string, passwordName: string, ownSchema: string,
): Promise<void> {
  if (!IDENTIFIER.test(role)) throw new Error('A database role must be a plain lowercase identifier.')
  if (!/^[\x21-\x7e]+$/.test(password)) throw new Error(`${passwordName} must be printable ASCII.`)
  const existing = (await client.query<{ administrative: boolean; owns: boolean }>(
    `SELECT r.rolsuper OR r.rolname = current_user AS administrative, EXISTS (
       SELECT FROM pg_shdepend d WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid AND d.deptype = 'o'
          AND ${OUTSIDE_OWN_SCHEMA}
     ) AS owns FROM pg_roles r WHERE r.rolname = $1`,
    [role, ownSchema],
  )).rows[0]
  if (existing?.administrative) throw new Error(`Refusing to restrict ${role}: it administers this database.`)
  if (existing?.owns) throw new Error(`Refusing to restrict ${role}: it owns objects outside its ${ownSchema} schema.`)
  const verifier = client.escapeLiteral(scramSha256Verifier(password))
  await client.query(
    `${existing ? 'ALTER' : 'CREATE'} ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${verifier}`,
  )
  const memberships = await client.query<{ granted: string; grantor: string }>(
    `SELECT g.rolname AS granted, o.rolname AS grantor FROM pg_auth_members m
     JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles o ON o.oid = m.grantor WHERE m.member = $1::regrole`,
    [role],
  )
  for (const { granted, grantor } of memberships.rows)
    await client.query(`REVOKE ${client.escapeIdentifier(granted)} FROM ${role} GRANTED BY ${client.escapeIdentifier(grantor)}`)

  // Privileges survive the attributes above: a schema CREATE, a table TRIGGER or a default privilege granted to the
  // role, by an earlier start or by hand, still works. Each object in this database that records a grant to the role
  // has it revoked. Its CONNECT and TEMPORARY on this database stay, in case PUBLIC was denied them.
  const database = (await client.query<{ name: string }>('SELECT current_database() AS name')).rows[0]!.name
  await client.query(`REVOKE CREATE ON DATABASE ${client.escapeIdentifier(database)} FROM ${role}`)
  const grants = await client.query<{ statement: string | null }>(
    `SELECT DISTINCT CASE d.classid
         WHEN 'pg_namespace'::regclass THEN format('REVOKE ALL ON SCHEMA %s FROM %I', d.objid::regnamespace, $1::text)
         WHEN 'pg_class'::regclass THEN (SELECT format('REVOKE ALL ON %s %s FROM %I',
           CASE c.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, c.oid::regclass, $1::text) FROM pg_class c WHERE c.oid = d.objid)
         WHEN 'pg_proc'::regclass THEN format('REVOKE ALL ON ROUTINE %s FROM %I', d.objid::regprocedure, $1::text)
         WHEN 'pg_type'::regclass THEN (SELECT format('REVOKE ALL ON %s %s FROM %I',
           CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, t.oid::regtype, $1::text) FROM pg_type t WHERE t.oid = d.objid)
         WHEN 'pg_default_acl'::regclass THEN (SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE ALL ON %s FROM %I',
           pg_get_userbyid(a.defaclrole), CASE WHEN a.defaclnamespace <> 0 THEN format(' IN SCHEMA %s', a.defaclnamespace::regnamespace) ELSE '' END,
           CASE a.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS' WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' END,
           $1::text) FROM pg_default_acl a WHERE a.oid = d.objid)
       END AS statement
       FROM pg_shdepend d WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = $1::regrole AND d.deptype = 'a'
        AND d.dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND ${OUTSIDE_OWN_SCHEMA}`,
    [role, ownSchema],
  )
  for (const { statement } of grants.rows) if (statement) await client.query(statement)

  // A REVOKE only removes what the object's owner granted, and what PUBLIC holds is every role's. So the role is
  // refused, rather than claimed restricted, while it can still create schemas or objects outside its own, holds a
  // grant another role made (or one on a large object, language, server, tablespace or parameter), or reaches
  // something through PUBLIC that a fresh FREE database grants PUBLIC nowhere: a table or column privilege outside
  // the system catalogs, or an extraction_runtime routine. The same holds for objects created later: a default
  // privilege giving PUBLIC anything on new tables or sequences outside the role's own schema (a global one included,
  // whoever creates them), EXECUTE on new extraction_runtime routines, or CREATE on new schemas. Default privileges
  // have no column form; elsewhere, the routine EXECUTE and type USAGE they can give PUBLIC are PostgreSQL's built-in
  // defaults, and schema USAGE alone neither creates objects nor reaches tables, so an extraction_runtime routine a
  // migration creates stays checked above.
  const refusals = (await client.query<{ reason: string }>(
    `SELECT format('it still holds a privilege on %s', pg_describe_object(d.classid, d.objid, d.objsubid)) AS reason
       FROM pg_shdepend d WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = $1::regrole AND d.deptype = 'a'
        AND d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
        AND d.classid <> 'pg_database'::regclass AND ${OUTSIDE_OWN_SCHEMA}
     UNION ALL
     SELECT 'it can create schemas in this database' WHERE has_database_privilege($1, current_database(), 'CREATE')
     UNION ALL
     SELECT format('it can create objects in schema %I', n.nspname) FROM pg_namespace n
      WHERE n.oid <> coalesce(to_regnamespace($2)::oid, 0) AND has_schema_privilege($1, n.oid, 'CREATE')
     UNION ALL
     SELECT format('PUBLIC holds %s on %s', a.privilege_type, c.oid::regclass) FROM pg_class c, aclexplode(c.relacl) a
      WHERE a.grantee = 0 AND c.relnamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
        AND c.relnamespace <> coalesce(to_regnamespace($2)::oid, 0)
     UNION ALL
     SELECT format('PUBLIC holds %s on column %I of %s', a.privilege_type, t.attname, c.oid::regclass)
       FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid, aclexplode(t.attacl) a
      WHERE a.grantee = 0 AND c.relnamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
        AND c.relnamespace <> coalesce(to_regnamespace($2)::oid, 0)
     UNION ALL
     SELECT format('PUBLIC can execute %s', p.oid::regprocedure) FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.pronamespace = to_regnamespace('extraction_runtime') AND a.grantee = 0
     UNION ALL
     SELECT format('PUBLIC is granted %s on new %s that %I creates%s', string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type),
         CASE x.defaclobjtype WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences' WHEN 'f' THEN 'routines' ELSE 'schemas' END,
         pg_get_userbyid(x.defaclrole), CASE WHEN x.defaclnamespace <> 0 THEN format(' in schema %s', x.defaclnamespace::regnamespace) ELSE '' END)
       FROM pg_default_acl x, aclexplode(x.defaclacl) a
      WHERE a.grantee = 0 AND (x.defaclobjtype IN ('r', 'S') AND x.defaclnamespace IS DISTINCT FROM to_regnamespace($2)::oid
                               OR x.defaclobjtype = 'f' AND x.defaclnamespace = to_regnamespace('extraction_runtime')
                               OR x.defaclobjtype = 'n' AND a.privilege_type = 'CREATE')
      GROUP BY x.oid
     LIMIT 6`,
    [role, ownSchema],
  )).rows.map(({ reason }) => reason)
  if (refusals.length > 0)
    throw new Error(`Refusing to restrict ${role}: ${refusals.slice(0, 5).join('; ')}${refusals.length > 5 ? '; and more' : ''}.`)
}

/**
 * kei parses untrusted PDFs, so its role owns its own DBOS schema and nothing else: it cannot read or rewrite
 * Studio's tables in `public` or Studio's workflow inputs in `dbos`. Idempotent; runs as the database owner after
 * the migrations, on every Studio start.
 */
export async function ensureKeiRole(
  client: ClientBase,
  options: Readonly<{ password: string; role?: string; schema?: string }>,
): Promise<void> {
  const role = options.role ?? KEI_ROLE
  const schema = options.schema ?? KEI_SCHEMA
  if (!IDENTIFIER.test(role) || !IDENTIFIER.test(schema))
    throw new Error('The kei role and schema must be plain lowercase identifiers.')
  await client.query('BEGIN')
  try {
    // PostgreSQL grants every role USAGE on `public` (and CREATE before PostgreSQL 15); Studio's runtime role gets its
    // own grant (ensureStudioRole).
    await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC')
    await ensureLoginRole(client, role, options.password, 'FREE_KEI_POSTGRES_PASSWORD', schema)
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ${role}`)
    await client.query(`ALTER SCHEMA ${schema} OWNER TO ${role}`)
    const runtime = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'extraction_runtime'")
    if (runtime.rowCount) {
      await client.query(`GRANT USAGE ON SCHEMA extraction_runtime TO ${role}`)
      for (const routine of EXTRACTION_RUNTIME_ROUTINES)
        await client.query(`GRANT EXECUTE ON FUNCTION extraction_runtime.${routine} TO ${role}`)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
