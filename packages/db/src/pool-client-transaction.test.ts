import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isUniqueViolation } from './pool-client-transaction.js'

test('a unique violation is found through a cause chain and matched by its constraint', () => {
  const violation = { code: '23505', constraint: 'extraction_pkey' }
  const wrapped = new Error('commit failed', { cause: new Error('driver', { cause: violation }) })
  assert.equal(isUniqueViolation(wrapped), true)
  assert.equal(isUniqueViolation(wrapped, 'extraction_pkey'), true)
  assert.equal(isUniqueViolation(wrapped, 'extraction_batch_source_key'), false)
  assert.equal(isUniqueViolation({ sqlState: '23505', constraint: 'extraction_pkey' }, 'extraction_pkey'), true)
  assert.equal(isUniqueViolation(new Error('other', { cause: { code: '23503' } })), false)
})

test('a cause chain that loops back on itself ends', () => {
  const first = new Error('first') as Error & { cause?: unknown }
  const second = new Error('second', { cause: first })
  first.cause = second
  assert.equal(isUniqueViolation(first), false)
})
