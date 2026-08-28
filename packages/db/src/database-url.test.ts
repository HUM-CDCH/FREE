import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { localDevelopmentDatabase } from './database-url.js'

describe('local development database URL', () => {
  it('allows only the conventional local FREE database', () => {
    assert.equal(
      localDevelopmentDatabase(
        'postgresql://postgres:postgres@localhost:5432/free',
      ).pathname,
      '/free',
    )
    assert.throws(
      () => localDevelopmentDatabase('postgresql://localhost/free_test'),
      /local development database named "free"/,
    )
    assert.throws(
      () => localDevelopmentDatabase('postgresql://database.example/free'),
      /local development database named "free"/,
    )
    assert.throws(
      () => localDevelopmentDatabase('postgresql://db/free'),
      /local development database named "free"/,
    )
    assert.equal(
      localDevelopmentDatabase('postgresql://db/free', true).pathname,
      '/free',
    )
  })
})
