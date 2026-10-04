import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { Client, Pool } from 'pg'
import { migrate, provisionDatabase, seedPreMigrationHistory, snapshotHistory } from '../../db/src/record-scope-history-fixture.js'
import { legacyIdentityMap, readLegacyExtraction } from './legacy-extraction.js'
import { DurableNotFound } from './durable-repository.js'

const baseUrl=process.env.EXTRACTION_TEST_DATABASE_URL
test('legacy capability reads preserve authoritative artifacts, reviews and missing-progress semantics',async t=> {
  if (!baseUrl) throw new Error('Set EXTRACTION_TEST_DATABASE_URL to an explicit disposable free_test_* target.')
  const target=await provisionDatabase(baseUrl,`free_test_durable_legacy_${randomBytes(5).toString('hex')}`)
  const client=new Client({connectionString:target.url}), pool=new Pool({connectionString:target.url,max:2})
  t.after(async()=>{await pool.end();await client.end();await target.drop()})
  await migrate(target.url,'20261003T1357_start_page');await client.connect()
  const history=await seedPreMigrationHistory(client),before=await snapshotHistory(client)
  await migrate(target.url)
  const completed=await readLegacyExtraction(history.accountId,history.extractions.article.reviewed,pool)
  assert.equal(completed.protocol,0);assert.equal(completed.artifactAvailability,'available')
  assert.deepEqual(completed.identityMap,legacyIdentityMap(history.extractions.article.reviewed,completed.extraction.resultPayload))
  assert.equal(completed.extraction.reviewDraftVersion,2)
  for (const id of [history.extractions.article.failed,history.extractions.article.inFlight]) {
    const read=await readLegacyExtraction(history.accountId,id,pool)
    assert.equal(read.identityMap,null);assert.equal(read.artifactAvailability,'unavailable')
  }
  await assert.rejects(readLegacyExtraction('00000000-0000-4000-8000-000000000000',history.extractions.article.reviewed,pool),DurableNotFound)
  assert.deepEqual(await snapshotHistory(client),before)
})
