import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const CI_DATABASE_URLS = Object.freeze({
  extraction:
    'postgresql://postgres:postgres@127.0.0.1:5432/free_test_extraction',
  projectStore:
    'postgresql://postgres:postgres@127.0.0.1:5432/free_test_project_store',
  parsing:
    'postgresql://postgres:postgres@127.0.0.1:5432/free_test_parsing',
})

function required(environment, name) {
  const value = environment[name]
  if (!value) throw new Error(`${name} is required by pnpm test:ci.`)
  return value
}

function validateFixedTarget(name, value, expectedDatabase, expectedValue) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be the fixed disposable CI database URL.`)
  }
  if (
    url.protocol !== 'postgresql:' ||
    url.username !== 'postgres' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '5432' ||
    url.pathname !== `/${expectedDatabase}` ||
    url.searchParams.size !== 0 ||
    value !== expectedValue
  )
    throw new Error(`${name} must be the fixed disposable CI database URL.`)
}

export function validateCiEnvironment(environment) {
  if (environment.CI !== 'true')
    throw new Error('pnpm test:ci requires CI=true.')

  const databaseUrl = required(environment, 'DATABASE_URL')
  const extractionUrl = required(environment, 'EXTRACTION_TEST_DATABASE_URL')
  const projectStoreUrl = required(environment, 'PROJECT_STORE_POSTGRES_URL')
  const parsingUrl = required(environment, 'PARSING_TEST_DATABASE_URL')

  if (databaseUrl !== extractionUrl)
    throw new Error(
      'DATABASE_URL must equal the disposable EXTRACTION_TEST_DATABASE_URL.',
    )
  if (projectStoreUrl === extractionUrl)
    throw new Error('CI PostgreSQL checks require two distinct databases.')

  validateFixedTarget(
    'EXTRACTION_TEST_DATABASE_URL',
    extractionUrl,
    'free_test_extraction',
    CI_DATABASE_URLS.extraction,
  )
  validateFixedTarget(
    'PROJECT_STORE_POSTGRES_URL',
    projectStoreUrl,
    'free_test_project_store',
    CI_DATABASE_URLS.projectStore,
  )
  validateFixedTarget(
    'PARSING_TEST_DATABASE_URL',
    parsingUrl,
    'free_test_parsing',
    CI_DATABASE_URLS.parsing,
  )

  return { databaseUrl, extractionUrl, projectStoreUrl, parsingUrl }
}

function runPnpm(arguments_, environment = process.env) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const child = spawn(command, arguments_, {
    env: environment,
    shell: false,
    stdio: 'inherit',
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else
        reject(
          new Error(
            `pnpm ${arguments_.join(' ')} exited with ${code ?? signal ?? 'an unknown status'}.`,
          ),
        )
    })
  })
}

export async function runCi(environment = process.env) {
  const { extractionUrl, projectStoreUrl } = validateCiEnvironment(environment)

  await runPnpm(['--filter', 'db', 'db:init'], {
    ...environment,
    DATABASE_URL: projectStoreUrl,
  })
  await runPnpm(['--filter', 'db', 'db:init'], {
    ...environment,
    DATABASE_URL: extractionUrl,
  })
  await runPnpm(['test:all'], environment)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await runCi()
