import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
const root=resolve(import.meta.dirname,'../migrations/app')
const dir=resolve(root,'20261004T1159_durable_extraction')
const read=(file:string)=>JSON.parse(readFileSync(resolve(dir,file),'utf8'))
test('the durable expansion preserves the complete public contract and advances the migration reference',()=> {
  const start=read('start-contract.json'),end=read('end-contract.json')
  assert.deepEqual(end.storage.namespaces.public,start.storage.namespaces.public)
  const migration=read('migration.json'),ref=JSON.parse(readFileSync(resolve(root,'refs/db.json'),'utf8'))
  assert.equal(migration.from,start.storage.storageHash)
  assert.equal(migration.to,end.storage.storageHash)
  assert.equal(ref.hash,migration.to)
})
