import { Client } from 'pg'
import { ensureKeiRole } from './kei-role.js'
import { ensureStudioRole } from './studio-role.js'

// Studio's entrypoint runs this on the administrative connection after the migrations, before it starts Studio on
// DATABASE_URL: that URL's user and password are the runtime role this prepares.
const adminUrl = process.env.FREE_ADMIN_DATABASE_URL
const runtimeUrl = process.env.DATABASE_URL
const keiPassword = process.env.FREE_KEI_POSTGRES_PASSWORD
if (!adminUrl || !runtimeUrl || !keiPassword) {
  console.error('FREE_ADMIN_DATABASE_URL, DATABASE_URL and FREE_KEI_POSTGRES_PASSWORD must be set.')
  process.exit(1)
}
// Parsed here so a malformed value is reported without echoing it: Node's URL error carries its input.
const parse = (name: string, value: string) => {
  try {
    return new URL(value)
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL.`)
  }
}
const admin = parse('FREE_ADMIN_DATABASE_URL', adminUrl)
const runtime = parse('DATABASE_URL', runtimeUrl)
if (admin.host !== runtime.host || admin.pathname !== runtime.pathname)
  throw new Error('FREE_ADMIN_DATABASE_URL and DATABASE_URL must name the same database.')

const client = new Client({ connectionString: adminUrl })
await client.connect()
try {
  await ensureKeiRole(client, { password: keiPassword })
  await ensureStudioRole(client, {
    role: decodeURIComponent(runtime.username),
    password: decodeURIComponent(runtime.password),
  })
} finally {
  await client.end()
}
console.log('The kei role and its kei_dbos schema, and Studio\'s runtime role, are ready.')
