import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { validateDestructiveDatabaseTarget } from './database-url.js'

const repositoryRoot = new URL('../../..', import.meta.url)
let configuredUrl = process.env.DATABASE_URL
if (!configuredUrl) {
  try {
    configuredUrl = parseEnv(
      readFileSync(new URL('.env', repositoryRoot), 'utf8'),
    ).DATABASE_URL
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error
  }
}
if (!configuredUrl) throw new Error('DATABASE_URL is required.')

const devContainer = process.env.FREE_DEVCONTAINER === '1'
const database = validateDestructiveDatabaseTarget(configuredUrl, {
  allowDevContainerHost: devContainer,
})

if (devContainer) {
  console.log('Using the Dev Container PostgreSQL service.')
  process.exit(0)
}

if (
  (database.port && database.port !== '5432') ||
  database.username !== 'postgres' ||
  database.password !== 'postgres'
)
  throw new Error(
    'Host development requires DATABASE_URL=postgresql://postgres:postgres@localhost:5432/free.',
  )

// The database is the root Compose stack's db service; the development
// overlay publishes it on 127.0.0.1:5432 for host-run tools.
const result = spawnSync(
  'docker',
  [
    'compose',
    '-f',
    'compose.yaml',
    '-f',
    'compose.override.yaml',
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '30',
    'db',
  ],
  {
    stdio: 'inherit',
    cwd: repositoryRoot,
    env: {
      ...process.env,
      COMPOSE_DISABLE_ENV_FILE: '1',
      FREE_POSTGRES_PASSWORD: 'postgres',
    },
  },
)

if (result.error) {
  const unavailable =
    'code' in result.error && result.error.code === 'ENOENT'
  throw new Error(
    unavailable
      ? 'Docker is required for host development. Install and start Docker Desktop, then run `pnpm dev` again.'
      : 'Docker could not start the development database.',
    { cause: result.error },
  )
}
if (result.status !== 0)
  throw new Error(
    'Docker could not start the development database. Ensure Docker Desktop is running and host port 5432 is available.',
  )

console.log('Development PostgreSQL is ready on 127.0.0.1:5432.')
