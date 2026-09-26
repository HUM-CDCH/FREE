import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import type { ClientBase } from 'pg'

export const KEI_ROLE = 'kei'
export const KEI_SCHEMA = 'kei_dbos'
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

/** A SCRAM-SHA-256 verifier, so the plain password never reaches PostgreSQL or its logs. ASCII passwords only. */
export function scramSha256Verifier(password: string, salt = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
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
  if (!/^[\x21-\x7e]+$/.test(options.password))
    throw new Error('FREE_KEI_POSTGRES_PASSWORD must be printable ASCII.')
  const verifier = client.escapeLiteral(scramSha256Verifier(options.password))
  await client.query('BEGIN')
  try {
    const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount === 1
    await client.query(
      `${exists ? 'ALTER' : 'CREATE'} ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${verifier}`,
    )
    // PostgreSQL grants every role USAGE on `public`; Studio connects as the database owner and is unaffected.
    await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC')
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ${role}`)
    await client.query(`ALTER SCHEMA ${schema} OWNER TO ${role}`)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
