import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { it } from 'node:test'

type Step = { sql: string; params: unknown[] }
type Operation = { id: string; operationClass: string; execute?: Step[] }

const migrations = resolve(import.meta.dirname, '../migrations/app')
const named = (suffix: string) => resolve(migrations, readdirSync(migrations).find((name) => name.endsWith(suffix))!)
const directory = named('_start_page')
const operations = JSON.parse(readFileSync(resolve(directory, 'ops.json'), 'utf8')) as Operation[]

it('adds one nullable integer column and nothing else: no row is given a start page it never named', () => {
  assert.deepEqual(operations.map((operation) => [operation.id, operation.operationClass]),
    [['column.public.extraction.startPage', 'additive']])
  assert.match(operations[0]!.execute?.[0]?.sql ?? '', /^ALTER TABLE "public"\."extraction" ADD COLUMN "startPage" (?:int4|integer)$/)
})

it('follows the record-scope migration directly', () => {
  const migration = JSON.parse(readFileSync(resolve(directory, 'migration.json'), 'utf8')) as { from: string; to: string }
  const previous = JSON.parse(readFileSync(resolve(named('_schema_revision_record_scope'), 'migration.json'), 'utf8')) as { to: string }
  assert.equal(migration.from, previous.to)
})
