/** Install the production migrations and worker privileges on a guarded Python test database. */
import { Client } from 'pg'
import { validateDisposableTestDatabaseTarget } from './database-url.js'
import { ensureKeiRole } from './kei-role.js'
import { migrate } from './record-scope-history-fixture.js'

async function main() {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const { databaseUrl, role, password } = JSON.parse(input) as {
    databaseUrl: string; role: string; password: string
  }
  validateDisposableTestDatabaseTarget(databaseUrl)
  if (!/^free_test_parsing_[a-f0-9]{12}$/.test(role))
    throw new Error('The fixture worker must use its own disposable role.')
  await migrate(databaseUrl)
  const owner = new Client({ connectionString: databaseUrl })
  await owner.connect()
  try {
    await ensureKeiRole(owner, { role, password, schema: 'kei_dbos' })
  } finally {
    await owner.end()
  }
}

main().catch(() => {
  // The input and migration command contain credentials; do not print either on failure.
  console.error('Parsing Service coordination fixture bootstrap failed.')
  process.exitCode = 1
})
