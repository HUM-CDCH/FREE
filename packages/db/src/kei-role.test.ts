import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ClientBase } from 'pg'
import { ensureKeiRole, scramSha256Verifier } from './kei-role.js'

test('the verifier is SCRAM-SHA-256 and never contains the password', () => {
  const password = 'p'.repeat(32)
  const verifier = scramSha256Verifier(password, Buffer.alloc(16, 1), 4096)
  assert.match(verifier, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
  assert.ok(!verifier.includes(password))
})

test('role and schema names must be plain lowercase identifiers', async () => {
  const calls: string[] = []
  const client = {
    query: async (sql: string) => {
      calls.push(sql)
      return { rowCount: 0, rows: [] }
    },
    escapeLiteral: (value: string) => `'${value}'`,
  } as unknown as ClientBase
  await assert.rejects(
    ensureKeiRole(client, { password: 'a'.repeat(64), role: 'kei; drop' }),
    /plain lowercase identifiers/,
  )
  await assert.rejects(
    ensureKeiRole(client, { password: 'a'.repeat(64), schema: 'kei_dbos; drop' }),
    /plain lowercase identifiers/,
  )
  assert.deepEqual(calls, [])
})
