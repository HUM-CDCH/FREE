import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const migrationDirectory = resolve(
  import.meta.dirname,
  '../migrations/app/20260826T1742_entra_researcher_identity',
)

describe('Entra identity migration', () => {
  it('guards both owned tables before the first schema mutation', async () => {
    const operations = JSON.parse(
      await readFile(resolve(migrationDirectory, 'ops.json'), 'utf8'),
    ) as Array<{
      id: string
      operationClass: string
      postcheck: Array<{ sql: string }>
    }>

    assert.equal(operations[0]?.id, 'data_migration.require-empty-auth-cutover')
    assert.equal(operations[0]?.operationClass, 'data')
    const guard = operations[0]?.postcheck[0]?.sql ?? ''
    assert.match(guard, /NOT EXISTS/)
    assert.match(guard, /"researcherAccount" FULL JOIN "public"\."projectContext"/)
    assert.match(guard, /"projectContext"\."researcherAccountId"/)
    assert.equal(operations[1]?.operationClass, 'destructive')
  })

  it('ends with Entra identity fields and ownership deletion restricted', async () => {
    const contract = await readFile(
      resolve(migrationDirectory, 'end-contract.json'),
      'utf8',
    )

    assert.match(contract, /"tenantId"/)
    assert.match(contract, /"objectId"/)
    assert.match(contract, /"displayName"/)
    assert.doesNotMatch(contract, /"passwordHash"/)
    assert.match(
      contract,
      /"researcherAccountId"[\s\S]{0,500}"onDelete": "restrict"/,
    )
  })
})
