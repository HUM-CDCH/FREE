import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { it } from 'node:test'

type Step = { sql: string; params: unknown[] }
type Operation = { id: string; operationClass: string; execute?: Step[]; postcheck?: Step[] }

const migrations = resolve(import.meta.dirname, '../migrations/app')
const named = (suffix: string) => resolve(migrations, readdirSync(migrations).find((name) => name.endsWith(suffix))!)
const directory = named('_extraction_settings')
const operations = JSON.parse(readFileSync(resolve(directory, 'ops.json'), 'utf8')) as Operation[]

it('adds three nullable jsonb method snapshots with no default: no historical row is given guessed settings', () => {
  const columns = operations.filter((operation) => operation.operationClass === 'additive')
  assert.deepEqual(columns.map((operation) => operation.id).sort(), [
    'column.public.batchExtraction.requestedModels',
    'column.public.batchExtraction.requestedSettings',
    'column.public.extraction.requestedSettings',
  ])
  for (const operation of columns)
    assert.match(operation.execute?.[0]?.sql ?? '',
      /^ALTER TABLE "public"\."(?:extraction|batchExtraction)" ADD COLUMN "requested(?:Settings|Models)" jsonb$/)
})

it('gives each stored object document an empty extractionSettings and writes nothing else', () => {
  const data = operations.filter((operation) => operation.operationClass === 'data')
  assert.deepEqual(data.map((operation) => operation.id), ['data_migration.empty-extraction-settings'])
  const run = data[0]!.execute!.map((step) => step.sql).join('\n')
  assert.match(run, /^UPDATE "public"\."modelConfiguration" SET "document" = /)
  assert.ok(run.includes(`'{"extractionSettings": {}}'::jsonb`), run)
  assert.ok(run.includes('jsonb_typeof('), run)
  assert.ok(run.includes(`'extractionSettings'`), run)
  assert.doesNotMatch(run, /"extraction"|"batchExtraction"|"connections"|"extractionModels"|"ingestionModels"/)
})

it('follows the baseline directly', () => {
  const migration = JSON.parse(readFileSync(resolve(directory, 'migration.json'), 'utf8')) as { from: string }
  const baseline = JSON.parse(readFileSync(resolve(named('_baseline'), 'migration.json'), 'utf8')) as { to: string }
  assert.equal(migration.from, baseline.to)
})
