import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { validateDisposableTestDatabaseTarget } from 'db/database-url'

/** The Studio PostgreSQL tier runs on CI's extraction database; DATABASE_URL (read by `db` at import) must name it. */
export function disposableDatabaseUrl(): string {
  const url = process.env.EXTRACTION_TEST_DATABASE_URL
  if (!url || process.env.DATABASE_URL !== url)
    throw new Error('Export EXTRACTION_TEST_DATABASE_URL and DATABASE_URL, equal, naming a disposable free_test_* database.')
  validateDisposableTestDatabaseTarget(url)
  return url
}

export function testSchemas(hex = randomBytes(4).toString('hex')) {
  return { schema: `dbos_t_${hex}`, keiSchema: `kei_dbos_t_${hex}`, executorId: `studio-t-${hex}` }
}

export async function dropSchemas(url: string, ...schemas: string[]): Promise<void> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    for (const schema of schemas) {
      if (!/^(dbos|kei_dbos)_t_[0-9a-f]{8}$/.test(schema)) throw new Error(`Refusing to drop schema ${schema}.`)
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    }
  } finally {
    await client.end()
  }
}
