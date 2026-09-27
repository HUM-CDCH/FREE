import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  CI_DATABASE_URLS,
  ciTestScript,
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
      'pnpm typecheck && pnpm lint && pnpm test:unit:node && pnpm test:safety && pnpm test:postgres:node && pnpm test:e2e',
    )
    assert.equal(
      scripts['test:all'],
      'pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:safety && pnpm test:postgres && pnpm test:e2e && pnpm test:service',
    )
    assert.ok(!scripts['test:unit:node'].includes('parsing-service'))
    assert.ok(!scripts['test:postgres:node'].includes('parsing-service'))
    assert.ok(scripts.postinstall.includes('install:python'))
    const parsing = JSON.parse(
      readFileSync(new URL('../prototypes/parsing_service/package.json', import.meta.url), 'utf8'),
    )
    assert.equal(parsing.scripts['install:python'], 'node ../../scripts/install-python.mjs')
  })
})

describe('verify workflow', () => {
  it('skips Python and installs no uv', () => {
    const workflow = readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8')
    assert.match(workflow, /^\s+FREE_SKIP_PYTHON: '1'$/m)
    assert.doesNotMatch(workflow, /setup-uv/)
    assert.doesNotMatch(workflow, /PARSING_TEST_DATABASE_URL/)
    assert.doesNotMatch(workflow, /free_test_parsing/)
    assert.match(workflow, /run: pnpm test:ci$/m)
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
