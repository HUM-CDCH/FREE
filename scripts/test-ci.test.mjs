import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CI_DATABASE_URLS,
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
