import { Client } from 'pg'
import { ensureKeiRole, KEI_ROLE } from './kei-role.js'
import { ensureStudioQueueRole, ensureStudioRole, STUDIO_QUEUE_ROLE } from './studio-role.js'

// Studio's entrypoint runs this on the administrative connection after the migrations, before it starts Studio on
// DATABASE_URL: that URL's user and password are the runtime role this prepares.
const adminUrl = process.env.FREE_ADMIN_DATABASE_URL
const runtimeUrl = process.env.DATABASE_URL
const keiPassword = process.env.FREE_KEI_POSTGRES_PASSWORD
const queueUrl = process.env.FREE_KEI_QUEUE_DATABASE_URL
if (!adminUrl || !runtimeUrl || !keiPassword || !queueUrl) {
  console.error('FREE_ADMIN_DATABASE_URL, DATABASE_URL, FREE_KEI_POSTGRES_PASSWORD and FREE_KEI_QUEUE_DATABASE_URL must be set.')
  process.exit(1)
}
// Parsed here so a malformed value is reported without echoing it: Node's URL error carries its input.
const parse = (name: string, value: string) => {
  try {
    const url = new URL(value)
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error()
    return url
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL.`)
  }
}
const admin = parse('FREE_ADMIN_DATABASE_URL', adminUrl)
const runtime = parse('DATABASE_URL', runtimeUrl)
const queue = parse('FREE_KEI_QUEUE_DATABASE_URL', queueUrl)
if ([runtime, queue].some((url) => url.host !== admin.host || url.pathname !== admin.pathname))
  throw new Error('The administrative, Studio and kei queue URLs must name the same database.')
if (queue.search || queue.hash) throw new Error('FREE_KEI_QUEUE_DATABASE_URL cannot include a query or fragment.')
const runtimeRole = decodeURIComponent(runtime.username)
if (queue.username !== STUDIO_QUEUE_ROLE || [KEI_ROLE, STUDIO_QUEUE_ROLE].includes(runtimeRole))
  throw new Error('Studio, the kei worker and the kei queue must connect with distinct database roles.')
const queuePassword = decodeURIComponent(queue.password)
if ([admin.password, runtime.password].map(decodeURIComponent).includes(queuePassword) || keiPassword === queuePassword)
  throw new Error('The kei queue database password must be independent of the other database passwords.')

const client = new Client({ connectionString: adminUrl })
await client.connect()
try {
  await ensureKeiRole(client, { password: keiPassword })
  await ensureStudioQueueRole(client, { password: queuePassword })
  await ensureStudioRole(client, {
    role: runtimeRole,
    password: decodeURIComponent(runtime.password),
  })
} finally {
  await client.end()
}
console.log('The kei worker, Studio runtime and Studio queue database roles are ready.')
