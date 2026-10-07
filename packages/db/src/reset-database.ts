import 'dotenv/config'
import { Client } from 'pg'
import { validateDestructiveDatabaseTarget } from './database-url.js'

const configuredUrl = process.env.DATABASE_URL
if (!configuredUrl) throw new Error('DATABASE_URL is required.')

const adminUrl = validateDestructiveDatabaseTarget(configuredUrl)
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
