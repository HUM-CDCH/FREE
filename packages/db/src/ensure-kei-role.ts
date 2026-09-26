import { Client } from 'pg'
import { ensureKeiRole } from './kei-role.js'

const url = process.env.DATABASE_URL
const password = process.env.FREE_KEI_POSTGRES_PASSWORD
if (!url || !password) {
  console.error('DATABASE_URL and FREE_KEI_POSTGRES_PASSWORD must be set.')
  process.exit(1)
}
const client = new Client({ connectionString: url })
await client.connect()
try {
  await ensureKeiRole(client, { password })
} finally {
  await client.end()
}
console.log('The kei role and its kei_dbos schema are ready.')
