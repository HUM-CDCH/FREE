import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

export function skipsPython(environment) {
  return environment.FREE_SKIP_PYTHON === '1'
}

export function ciTestScript(environment) {
  return skipsPython(environment) ? 'test:all:node' : 'test:all'
}

// Run each `pnpm <script>` of the aggregate on its own so one failing tier
// cannot hide a later one.
export function ciSteps(environment) {
  const name = ciTestScript(environment)
  const { scripts } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  return scripts[name].split(' && ').map((segment) => {
    const match = /^pnpm ([\w:-]+)$/.exec(segment)
    if (!match)
      throw new Error(`${name} step "${segment}" must be "pnpm <script>".`)
    return match[1]
  })
}

export function validateCiEnvironment(environment) {
  if (environment.CI !== 'true')
    throw new Error('pnpm test:ci requires CI=true.')

  const databaseUrl = required(environment, 'DATABASE_URL')
  const extractionUrl = required(environment, 'EXTRACTION_TEST_DATABASE_URL')
  const projectStoreUrl = required(environment, 'PROJECT_STORE_POSTGRES_URL')
  const parsingUrl = skipsPython(environment)
    ? environment.PARSING_TEST_DATABASE_URL ?? null
    : required(environment, 'PARSING_TEST_DATABASE_URL')

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
  if (parsingUrl !== null)
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

export async function runCi(environment = process.env, run = runPnpm) {
  const { extractionUrl, projectStoreUrl } = validateCiEnvironment(environment)
  const steps = ciSteps(environment)

  // Prerequisites: the PostgreSQL and E2E tiers need both migrated targets.
  await run(['--filter', 'db', 'db:init'], {
    ...environment,
    DATABASE_URL: projectStoreUrl,
  })
  await run(['--filter', 'db', 'db:init'], {
    ...environment,
    DATABASE_URL: extractionUrl,
  })

  const failed = []
  for (const step of steps) {
    try {
      await run([step], environment)
    } catch (error) {
      console.error(error.message)
      failed.push(step)
    }
  }

  console.log('\npnpm test:ci summary:')
  for (const step of steps)
    console.log(`  ${failed.includes(step) ? 'FAIL' : 'PASS'} ${step}`)
  if (failed.length)
    throw new Error(
      `${failed.length} of ${steps.length} CI steps failed: ${failed.join(', ')}.`,
    )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await runCi()
