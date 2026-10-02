import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { it } from 'node:test'

type Step = { sql: string; params: unknown[] }
type Operation = { id: string; operationClass: string; execute?: Step[]; precheck?: Step[]; postcheck?: Step[] }

const migrations = resolve(import.meta.dirname, '../migrations/app')
const named = (suffix: string) => resolve(migrations, readdirSync(migrations).find((name) => name.endsWith(suffix))!)
const directory = named('_schema_revision_record_scope')
const operations = JSON.parse(readFileSync(resolve(directory, 'ops.json'), 'utf8')) as Operation[]

it('adds one nullable text recordScope beside the tree, with no default: no revision is given a guessed scope', () => {
  const columns = operations.filter((operation) => operation.operationClass === 'additive')
  assert.deepEqual(columns.map((operation) => operation.id), ['column.public.schemaRevision.recordScope'])
  assert.equal(columns[0]!.execute?.[0]?.sql, 'ALTER TABLE "public"."schemaRevision" ADD COLUMN "recordScope" text')
})

it('declares a NULL scope only from the one strategy its Extractions and Batch Extractions ran with', () => {
  const data = operations.filter((operation) => operation.operationClass === 'data')
  assert.deepEqual(data.map((operation) => operation.id), ['data_migration.schema-revision-record-scope'])
  const run = data[0]!.execute!.map((step) => step.sql).join('\n')
  assert.match(run, /^UPDATE "public"\."schemaRevision" SET "recordScope" = \(SELECT CASE MIN/)
  assert.ok(run.includes(`WHEN 'ARTICLE' THEN 'document' WHEN 'CATALOG' THEN 'records'`), run)
  assert.ok(run.includes('FROM "public"."extraction" WHERE "extraction"."schemaRevisionId" = "schemaRevision"."id"'), run)
  assert.ok(run.includes('FROM "public"."batchExtraction" WHERE "batchExtraction"."schemaRevisionId" = "schemaRevision"."id"'), run)
  // Zero or two distinct strategies leave the scope NULL: ambiguous, so a choice is required.
  assert.ok(run.includes('HAVING COUNT(DISTINCT "pinned"."strategy") = 1'), run)
  // A declared scope is never rewritten, and the stored tree is never touched.
  assert.match(run, / WHERE "recordScope" IS NULL AND \(SELECT /)
  assert.doesNotMatch(run, /"schemaTree"/)
})

it('checks exactly the rows the update would set, so the postcheck holds while ambiguous revisions stay NULL', () => {
  const data = operations.find((operation) => operation.operationClass === 'data')!
  const run = data.execute![0]!.sql
  const predicate = run.slice(run.indexOf(' WHERE "recordScope" IS NULL') + ' WHERE '.length)
  for (const step of [...data.precheck!, ...data.postcheck!])
    assert.ok(step.sql.includes(`FROM "public"."schemaRevision" WHERE ${predicate} LIMIT 1`), step.sql)
})

it('follows the optional-review-evidence migration directly', () => {
  const migration = JSON.parse(readFileSync(resolve(directory, 'migration.json'), 'utf8')) as { from: string; to: string }
  const previous = JSON.parse(readFileSync(resolve(named('_optional_review_evidence'), 'migration.json'), 'utf8')) as { to: string }
  assert.equal(migration.from, previous.to)
  const ref = JSON.parse(readFileSync(resolve(migrations, 'refs/db.json'), 'utf8')) as { hash: string }
  assert.equal(ref.hash, migration.to)
})
