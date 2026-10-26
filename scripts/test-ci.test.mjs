import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  CI_DATABASE_URLS,
  ciSteps,
  ciTestScript,
  runCi,
  skipsPython,
  validateCiEnvironment,
} from './test-ci.mjs'

function validEnvironment() {
  return {
    CI: 'true',
    DATABASE_URL: CI_DATABASE_URLS.extraction,
    EXTRACTION_TEST_DATABASE_URL: CI_DATABASE_URLS.extraction,
    PROJECT_STORE_POSTGRES_URL: CI_DATABASE_URLS.projectStore,
    PARSING_TEST_DATABASE_URL: CI_DATABASE_URLS.parsing,
  }
}

describe('CI database environment', () => {
  it('accepts the fixed, distinct disposable targets', () => {
    assert.deepEqual(validateCiEnvironment(validEnvironment()), {
      databaseUrl: CI_DATABASE_URLS.extraction,
      extractionUrl: CI_DATABASE_URLS.extraction,
      projectStoreUrl: CI_DATABASE_URLS.projectStore,
      parsingUrl: CI_DATABASE_URLS.parsing,
    })
  })

  it('requires CI and every database variable', () => {
    const withoutCi = validEnvironment()
    delete withoutCi.CI
    assert.throws(() => validateCiEnvironment(withoutCi), /requires CI=true/)

    for (const name of [
      'DATABASE_URL',
      'EXTRACTION_TEST_DATABASE_URL',
      'PROJECT_STORE_POSTGRES_URL',
      'PARSING_TEST_DATABASE_URL',
    ]) {
      const environment = validEnvironment()
      delete environment[name]
      assert.throws(
        () => validateCiEnvironment(environment),
        new RegExp(`${name} is required`),
      )
    }
  })

  it('requires DATABASE_URL to equal the extraction target', () => {
    const environment = validEnvironment()
    environment.DATABASE_URL = CI_DATABASE_URLS.projectStore
    assert.throws(
      () => validateCiEnvironment(environment),
      /DATABASE_URL must equal.*EXTRACTION_TEST_DATABASE_URL/,
    )
  })

  it('requires distinct PostgreSQL integration databases', () => {
    const environment = validEnvironment()
    environment.PROJECT_STORE_POSTGRES_URL = CI_DATABASE_URLS.extraction
    assert.throws(
      () => validateCiEnvironment(environment),
      /require two distinct databases/,
    )
  })

  it('rejects wrong database names and non-loopback hosts', () => {
    const wrongName = validEnvironment()
    wrongName.PROJECT_STORE_POSTGRES_URL =
      'postgresql://postgres:postgres@127.0.0.1:5432/free_test_wrong'
    assert.throws(
      () => validateCiEnvironment(wrongName),
      /PROJECT_STORE_POSTGRES_URL must be the fixed disposable CI database URL/,
    )

    const remote = validEnvironment()
    remote.DATABASE_URL = remote.EXTRACTION_TEST_DATABASE_URL =
      'postgresql://postgres:postgres@database.example:5432/free_test_extraction'
    assert.throws(
      () => validateCiEnvironment(remote),
      /EXTRACTION_TEST_DATABASE_URL must be the fixed disposable CI database URL/,
    )

    const parsing = validEnvironment()
    parsing.PARSING_TEST_DATABASE_URL =
      'postgresql://postgres:postgres@127.0.0.1:5432/free'
    assert.throws(
      () => validateCiEnvironment(parsing),
      /PARSING_TEST_DATABASE_URL must be the fixed disposable CI database URL/,
    )
  })
})

describe('CI without Python', () => {
  it('chooses the node aggregate only under the variable', () => {
    assert.equal(ciTestScript(validEnvironment()), 'test:all')
    assert.equal(ciTestScript({ ...validEnvironment(), FREE_SKIP_PYTHON: '1' }), 'test:all:node')
    assert.equal(ciTestScript({ ...validEnvironment(), FREE_SKIP_PYTHON: 'true' }), 'test:all')
    assert.equal(skipsPython({ FREE_SKIP_PYTHON: '1' }), true)
    assert.equal(skipsPython({}), false)
  })

  it('accepts a missing parsing database only when skipping Python', () => {
    const skipping = { ...validEnvironment(), FREE_SKIP_PYTHON: '1' }
    delete skipping.PARSING_TEST_DATABASE_URL
    assert.deepEqual(validateCiEnvironment(skipping), {
      databaseUrl: CI_DATABASE_URLS.extraction,
      extractionUrl: CI_DATABASE_URLS.extraction,
      projectStoreUrl: CI_DATABASE_URLS.projectStore,
      parsingUrl: null,
    })
    const notSkipping = validEnvironment()
    delete notSkipping.PARSING_TEST_DATABASE_URL
    assert.throws(() => validateCiEnvironment(notSkipping), /PARSING_TEST_DATABASE_URL is required/)
  })

  it('still validates a parsing URL that is present when skipping Python', () => {
    const stale = { ...validEnvironment(), FREE_SKIP_PYTHON: '1' }
    stale.PARSING_TEST_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/free'
    assert.throws(
      () => validateCiEnvironment(stale),
      /PARSING_TEST_DATABASE_URL must be the fixed disposable CI database URL/,
    )
  })

  it('the full chains end with the Parsing Service tiers', () => {
    const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(scripts['test:unit'], 'pnpm test:unit:node && pnpm --filter parsing-service test')
    assert.equal(scripts['test:postgres'], 'pnpm test:postgres:node && pnpm --filter parsing-service test:postgres')
    assert.equal(
      scripts['test:all:node'],
      'pnpm typecheck && pnpm lint && pnpm build && pnpm test:unit:node && pnpm test:safety && pnpm test:postgres:node && pnpm test:e2e',
    )
    assert.equal(
      scripts['test:all'],
      'pnpm typecheck && pnpm lint && pnpm build && pnpm test:unit && pnpm test:safety && pnpm test:postgres && pnpm test:e2e && pnpm test:service',
    )
    assert.ok(!scripts['test:unit:node'].includes('parsing-service'))
    assert.ok(!scripts['test:postgres:node'].includes('parsing-service'))
    assert.ok(scripts.postinstall.includes('install:python'))
    const parsing = JSON.parse(
      readFileSync(new URL('../apps/parsing_service/package.json', import.meta.url), 'utf8'),
    )
    assert.equal(parsing.scripts['install:python'], 'node ../../scripts/install-python.mjs')
  })
})

describe('CI step reporting', () => {
  const nodeEnvironment = () => ({ ...validEnvironment(), FREE_SKIP_PYTHON: '1' })
  // The production build runs in both aggregates: the browser tiers serve Studio from Vite, never the bundle.
  const nodeSteps = ['typecheck', 'lint', 'build', 'test:unit:node', 'test:safety', 'test:postgres:node', 'test:e2e']

  function fakeRun(failing) {
    const calls = []
    const run = async (arguments_) => {
      calls.push(arguments_.join(' '))
      if (failing.includes(arguments_.at(-1))) throw new Error(`pnpm ${arguments_.join(' ')} exited with 1.`)
    }
    return { calls, run }
  }

  it('splits the chosen aggregate into its pnpm scripts', () => {
    assert.deepEqual(ciSteps(nodeEnvironment()), nodeSteps)
    assert.deepEqual(ciSteps(validEnvironment()), [
      'typecheck', 'lint', 'build', 'test:unit', 'test:safety', 'test:postgres', 'test:e2e', 'test:service',
    ])
  })

  it('runs every step after an early failure, lists failures, and rejects', async (t) => {
    const log = t.mock.method(console, 'log', () => {})
    t.mock.method(console, 'error', () => {})
    const { calls, run } = fakeRun(['lint', 'test:postgres:node'])

    await assert.rejects(runCi(nodeEnvironment(), run), /2 of 7 CI steps failed: lint, test:postgres:node\./)

    assert.deepEqual(calls, ['--filter db db:init', '--filter db db:init', ...nodeSteps])
    const output = log.mock.calls.map((call) => call.arguments.join(' ')).join('\n')
    assert.match(output, /^ {2}PASS typecheck$/m)
    assert.match(output, /^ {2}FAIL lint$/m)
    assert.match(output, /^ {2}FAIL test:postgres:node$/m)
    assert.match(output, /^ {2}PASS test:e2e$/m)
  })

  it('resolves when every step passes', async (t) => {
    t.mock.method(console, 'log', () => {})
    const { calls, run } = fakeRun([])
    await runCi(nodeEnvironment(), run)
    assert.equal(calls.length, 9)
  })

  it('stops before the test steps when a database cannot be migrated', async () => {
    const { calls, run } = fakeRun(['db:init'])
    await assert.rejects(runCi(nodeEnvironment(), run), /db:init exited with 1/)
    assert.deepEqual(calls, ['--filter db db:init'])
  })
})

describe('verify workflow', () => {
  const workflow = readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8')
  const job = (name) => new RegExp(`^  ${name}:\\n((?: {4}.*\\n|\\n)*)`, 'm').exec(workflow)?.[1] ?? ''
  // A job's top-level `env:` block, as the variables its steps see.
  const jobEnvironment = (name) => Object.fromEntries(
    [.../^ {4}env:\n((?: {6}.*\n)*)/m.exec(job(name))[1].matchAll(/^ {6}(\w+): (.*)$/gm)]
      .map(([, key, value]) => [key, value.replace(/^'(.*)'$/, '$1')]))

  it('gates pull requests into and pushes to dev with the fast checks, and main with pnpm test:ci', () => {
    for (const event of ['pull_request', 'push'])
      assert.match(workflow, new RegExp(`^  ${event}:\\n    branches: \\[main, dev\\]$`, 'm'))
    assert.match(workflow, /^  merge_group:$/m)
    assert.ok(job('fast').includes("if: github.base_ref == 'dev' || github.ref == 'refs/heads/dev'\n"))
    assert.ok(job('verify').includes("if: github.base_ref != 'dev' && github.ref != 'refs/heads/dev'\n"))
    for (const command of ['pnpm typecheck', 'pnpm lint', 'pnpm test:unit'])
      assert.match(job('fast'), new RegExp(`run: ${command}$`, 'm'))
    assert.doesNotMatch(job('fast'), /services:|test:ci/)
    assert.match(job('verify'), /run: pnpm test:ci$/m)
  })

  it('installs the Parsing Service environment in both jobs', () => {
    const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    for (const name of ['fast', 'verify']) {
      assert.equal(skipsPython(jobEnvironment(name)), false, `${name} runs the Python tiers`)
      // The interpreter the Parsing Service pins, and a fixed uv for its frozen sync during `pnpm install`.
      assert.match(job(name), /uses: actions\/setup-python@v\d+\n {8}with:\n {10}python-version-file: apps\/parsing_service\/\.python-version$/m)
      assert.match(job(name), /uses: astral-sh\/setup-uv@v\d+\n {8}with:\n {10}version: \d+\.\d+\.\d+$/m)
      assert.ok(job(name).indexOf('setup-uv') < job(name).indexOf('pnpm install --frozen-lockfile'))
    }
    assert.match(scripts['test:unit'], /pnpm --filter parsing-service test$/)
  })

  it('gives pnpm test:ci the full aggregate with the three fixed databases it creates', () => {
    const environment = jobEnvironment('verify')
    assert.deepEqual(validateCiEnvironment(environment), {
      databaseUrl: CI_DATABASE_URLS.extraction,
      extractionUrl: CI_DATABASE_URLS.extraction,
      projectStoreUrl: CI_DATABASE_URLS.projectStore,
      parsingUrl: CI_DATABASE_URLS.parsing,
    })
    assert.deepEqual(ciSteps(environment), [
      'typecheck', 'lint', 'build', 'test:unit', 'test:safety', 'test:postgres', 'test:e2e', 'test:service',
    ])
    // The service container creates the project store; test:ci migrates both Studio targets itself.
    assert.match(job('verify'), /POSTGRES_DB: free_test_project_store$/m)
    for (const database of ['free_test_extraction', 'free_test_parsing'])
      assert.match(job('verify'), new RegExp(`createdb --username postgres ${database}$`, 'm'))
    // The durable lifecycle and recovery checks run their Python side in the worker image they name by default.
    assert.match(job('verify'), /run: docker build --tag free-parsing_worker apps\/parsing_service$/m)
    assert.ok(job('verify').indexOf('free-parsing_worker') < job('verify').indexOf('pnpm test:ci'))
  })
})

describe('Parsing Service service smoke', () => {
  // Its fixture closure marks it postgres (conftest.py) and its module marks it live_model, so neither test:postgres
  // ("postgres and not live_model") nor test:live-model ("live_model and not postgres") selects it: only
  // test:service does. Its generated born-digital PDF needs no model server.
  it('runs in the full service tier, which test:ci runs', () => {
    const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const parsing = JSON.parse(readFileSync(new URL('../apps/parsing_service/package.json', import.meta.url), 'utf8'))
    assert.equal(parsing.scripts['test:service'], 'uv run --no-sync pytest -q tests/test_service_smoke.py')
    assert.ok(scripts['test:service'].split(' && ').includes('pnpm --filter parsing-service test:service'))
    assert.ok(ciSteps(validEnvironment()).includes('test:service'))
  })
})

describe('PostgreSQL tier wiring', () => {
  it('the Node aggregate runs the db, extraction, and Studio PostgreSQL tiers', () => {
    const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts
    assert.match(scripts['test:all:node'], /pnpm test:postgres:node/)
    assert.match(scripts['test:postgres:node'], /pnpm --filter db test:postgres/)
    assert.match(scripts['test:postgres:node'], /pnpm --filter extraction test:postgres/)
    assert.match(scripts['test:postgres:node'], /pnpm --filter studio test:postgres/)
  })

  it('db checks reprocessing and garbage references against PostgreSQL', () => {
    const scripts = JSON.parse(readFileSync(new URL('../packages/db/package.json', import.meta.url), 'utf8')).scripts
    assert.match(scripts['test:postgres'], /source-reprocessing\.postgres\.check\.ts/)
    assert.match(scripts['test:postgres'], /garbage-references\.postgres\.check\.ts/)
  })
})

describe('Playwright listener ports', () => {
  it('keeps every stack outside Linux client ports and gives each listener its own port', () => {
    const studio = new URL('../apps/studio/', import.meta.url)
    const ports = []
    for (const file of readdirSync(studio).filter((name) => /^playwright.*\.config\.ts$/.test(name))) {
      const source = readFileSync(new URL(file, studio), 'utf8')
      const defaults = [...source.matchAll(/(?:applicationPort|oidcPort|postgresPort):\s*([\d_]+)/g)]
      assert.equal(defaults.length, 3, `${file} must declare its three stack ports`)
      for (const [, value] of defaults) {
        const port = Number(value.replaceAll('_', ''))
        assert.ok(port >= 30_000 && port < 32_768, `${file}: ${port} overlaps lease or client ports`)
        ports.push(port)
      }
    }
    assert.ok(ports.length > 0)
    assert.equal(new Set(ports).size, ports.length, 'Playwright stacks must not share listener ports')
  })
})

describe('Playwright entry configs', () => {
  const studio = fileURLToPath(new URL('../apps/studio/', import.meta.url))
  const configs = readdirSync(studio).filter((name) => /^playwright.*\.config\.ts$/.test(name)).sort()

  // Playwright's own loader in list mode, as CI runs it: it evaluates each config and collects its tests without
  // starting a stack, browser or database. The state paths keep the configs from creating temporary directories.
  async function list(config) {
    const environment = {
      ...process.env,
      CI: 'true',
      FREE_PLAYWRIGHT_SOURCE_INBOX: join(tmpdir(), 'free-e2e-source-inbox-list'),
      FREE_DURABLE_E2E_STATE: join(tmpdir(), 'free-durable-e2e-state-list'),
      FREE_DURABLE_E2E_INBOX: join(tmpdir(), 'free-durable-e2e-inbox-list'),
    }
    delete environment.FREE_CATALOG_METHOD
    const { stdout } = await promisify(execFile)(process.execPath,
      [join(studio, 'node_modules/@playwright/test/cli.js'), 'test', '--config', config, '--list', '--reporter=json'],
      { cwd: studio, env: environment, maxBuffer: 64 * 1024 * 1024 })
    const report = JSON.parse(stdout)
    const tests = (suite) => [
      ...(suite.specs ?? []).flatMap((spec) => spec.tests.map((test) => ({ file: suite.file, ...test }))),
      ...(suite.suites ?? []).flatMap(tests),
    ]
    return { config: report.config, tests: report.suites.flatMap(tests) }
  }
  const listed = Promise.all(configs.map(list))

  it('every config runs in a canonical tier', () => {
    const { scripts } = JSON.parse(readFileSync(join(studio, 'package.json'), 'utf8'))
    const run = `${scripts['test:e2e']} && ${scripts['test:service']}`.split(' && ')
      .map((command) => /--config (\S+)/.exec(command)?.[1] ?? 'playwright.config.ts')
    assert.deepEqual([...run].sort(), configs)
  })

  it('every config refuses a focused test in CI', async () => {
    for (const [index, { config }] of (await listed).entries())
      assert.equal(config.forbidOnly, true, configs[index])
  })

  it('the unified Catalog suite runs with the rollout gate on in the runner and in Studio', async () => {
    const { config, tests } = (await listed)[configs.indexOf('playwright.unified-catalog.config.ts')]
    assert.equal(config.webServer.env.FREE_CATALOG_METHOD, 'unified')
    assert.ok(tests.length > 0)
    for (const test of tests) {
      assert.equal(test.file, 'unified-catalog.spec.ts')
      assert.equal(test.expectedStatus, 'passed', 'its specs skip only while the gate is off')
    }
  })

  it('the base-path suite serves Studio under /free', async () => {
    const { config, tests } = (await listed)[configs.indexOf('playwright.base-path.config.ts')]
    assert.equal(config.webServer.env.STUDIO_BASE_PATH, '/free')
    assert.ok(tests.length > 0)
  })
})
