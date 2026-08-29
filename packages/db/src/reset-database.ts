import { Client } from 'pg'
import { validateDestructiveDatabaseTarget } from './database-url.js'

// Only the process environment may authorize the Dev Container host. Load the
// remaining configuration after this snapshot so .env cannot widen the reset
// boundary.
const allowDevContainerHost = process.env.FREE_DEVCONTAINER === '1'
await import('dotenv/config')

const configuredUrl = process.env.DATABASE_URL
if (!configuredUrl) throw new Error('DATABASE_URL is required.')

const adminUrl = validateDestructiveDatabaseTarget(configuredUrl, {
  allowDevContainerHost,
})
adminUrl.pathname = '/postgres'
const client = new Client({ connectionString: adminUrl.toString() })
await client.connect()
try {
  await client.query('DROP DATABASE IF EXISTS "free" WITH (FORCE)')
  await client.query('CREATE DATABASE "free"')
} finally {
  await client.end()
}
console.log('Reset local development database free.')
