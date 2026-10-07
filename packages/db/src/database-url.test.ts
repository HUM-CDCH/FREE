import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  validateDestructiveDatabaseTarget,
  validateDisposableTestDatabaseTarget,
} from './database-url.js'

const destructiveTargetError = /Destructive database operations require/
const disposableTargetError = /Disposable PostgreSQL tests require/

describe('destructive database target', () => {
  it('accepts the free database on each loopback spelling', () => {
    for (const value of [
      'postgresql://postgres:local@localhost:5432/free',
      'postgresql://postgres@127.0.0.1:5432/free',
      'postgresql://postgres:different-password@[::1]:5432/free',
    ])
      assert.equal(
        validateDestructiveDatabaseTarget(value).pathname,
        '/free',
      )
  })

  it('rejects non-loopback hosts even when the database is named free', () => {
    for (const value of [
      'postgresql://postgres:local@db:5432/free',
      'postgresql://postgres:secret@db.production.example.com:5432/free',
      'postgresql://postgres:secret@localhost:5432/free?host=db.production.example.com',
    ])
      assert.throws(
        () => validateDestructiveDatabaseTarget(value),
        destructiveTargetError,
      )
  })

  it('rejects every query parameter', () => {
    for (const parameter of ['sslmode=disable', 'application_name=free-reset'])
      assert.throws(
        () =>
          validateDestructiveDatabaseTarget(
            `postgresql://postgres:local@localhost:5432/free?${parameter}`,
          ),
        destructiveTargetError,
      )
  })

  it('rejects the wrong protocol, user, port, or database', () => {
    for (const value of [
      'http://postgres:local@localhost:5432/free',
      'postgresql://application:local@localhost:5432/free',
      'postgresql://postgres:local@localhost/free',
      'postgresql://postgres:local@localhost:5433/free',
      'postgresql://postgres:local@localhost:5432/researchdata',
    ])
      assert.throws(
        () => validateDestructiveDatabaseTarget(value),
        destructiveTargetError,
      )
  })
})

describe('disposable PostgreSQL test target', () => {
  it('accepts free_test_* databases on each loopback spelling', () => {
    for (const value of [
      'postgresql://postgres:test@localhost:5432/free_test_cascade',
      'postgresql://postgres@127.0.0.1:5432/free_test_project_store',
      'postgresql://postgres:any-password@[::1]:5432/free_test_ipv6',
    ])
      assert.ok(
        validateDisposableTestDatabaseTarget(value).pathname.startsWith(
          '/free_test_',
        ),
      )
  })

  it('rejects non-loopback hosts even for free_test_* databases', () => {
    for (const value of [
      'postgresql://postgres:test@database.example:5432/free_test_cascade',
      'postgresql://postgres:test@db:5432/free_test_cascade',
      'postgresql://postgres:test@localhost:5432/free_test_cascade?host=database.example',
    ])
      assert.throws(
        () => validateDisposableTestDatabaseTarget(value),
        disposableTargetError,
      )
  })

  it('rejects every query parameter', () => {
    for (const parameter of [
      'database=free_test_override',
      'host=localhost',
      'port=5432',
      'user=postgres',
      'sslmode=disable',
      'application_name=free-tests',
    ])
      assert.throws(
        () =>
          validateDisposableTestDatabaseTarget(
            `postgresql://postgres:test@localhost:5432/free_test_cascade?${parameter}`,
          ),
        disposableTargetError,
      )
  })

  it('rejects the wrong protocol, user, port, or database', () => {
    for (const value of [
      'http://postgres:test@localhost:5432/free_test_cascade',
      'postgresql://application:test@localhost:5432/free_test_cascade',
      'postgresql://postgres:test@localhost/free_test_cascade',
      'postgresql://postgres:test@localhost:5433/free_test_cascade',
      'postgresql://postgres:test@localhost:5432/free',
      'postgresql://postgres:test@localhost:5432/free_test',
    ])
      assert.throws(
        () => validateDisposableTestDatabaseTarget(value),
        disposableTargetError,
      )
  })
})
