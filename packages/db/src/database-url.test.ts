import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { localDevelopmentDatabase } from './database-url.js'

describe('local development database URL', () => {
  it('allows only the conventional local FREE database to be reset', () => {
    assert.equal(
      localDevelopmentDatabase(
        'postgresql://postgres:postgres@localhost:5432/free',
      ).pathname,
      '/free',
    )
    assert.throws(
      () => localDevelopmentDatabase('postgresql://localhost/free_test'),
      /only accepts the local development database/,
    )
    assert.throws(
      () => localDevelopmentDatabase('postgresql://database.example/free'),
      /only accepts the local development database/,
    )
  })
})
