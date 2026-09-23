import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { it } from 'node:test'

const migrationDirectory = resolve(
  import.meta.dirname,
  '../migrations/app/20260831T1023_extraction_jobs',
)

type MigrationOperation = {
  id: string
  operationClass: string
  execute?: Array<{ sql: string }>
  postcheck?: Array<{ sql: string }>
}

async function operations(): Promise<MigrationOperation[]> {
  return JSON.parse(
    await readFile(resolve(migrationDirectory, 'ops.json'), 'utf8'),
  ) as MigrationOperation[]
}

it('creates the Extraction Job schema for empty batch tables', async () => {
  const all = await operations()

  assert.equal(all[0]?.id, 'data_migration.require-empty-batch-extraction-tables')
  assert.equal(all[1]?.id, 'table.extractionJob')
  assert.ok(
    all.some(
      (operation) =>
        operation.id ===
        'column.public.batchExtractionMember.initialExtractionJobId',
    ),
  )
  assert.ok(
    all.some(
      (operation) =>
        operation.id ===
        'alterNullability.setNotNull.batchExtractionMember.initialExtractionJobId',
    ),
  )
  assert.ok(
    all.some(
      (operation) =>
        operation.id ===
        'foreignKey.batchExtractionMember.batch_member_initial_job_fkey',
    ),
  )
  assert.ok(
    all.some((operation) =>
      operation.id === 'unique.extractionJob.extraction_job_retry_pin_key'),
  )
  const retryForeignKey = all.find((operation) =>
    operation.id === 'foreignKey.extractionJob.extraction_job_retry_pin_fkey')
  assert.match(
    retryForeignKey?.execute?.[0]?.sql ?? '',
    /REFERENCES "public"\."extractionJob"/,
  )
})

it('rejects populated batch tables before schema changes', async () => {
  const all = await operations()
  const guard = all[0]
  const postcheck = guard?.postcheck?.[0]?.sql ?? ''

  assert.equal(guard?.operationClass, 'data')
  assert.match(postcheck, /NOT EXISTS/)
  assert.match(postcheck, /"batchExtraction" FULL JOIN "public"\."batchExtractionMember"/)
  assert.match(postcheck, /"batchExtraction"\."id" = "batchExtractionMember"\."batchExtractionId"/)
  assert.equal(
    all.filter((operation) => operation.operationClass === 'data').length,
    1,
  )
})

it('adds the requested Extraction Model Choice as a nullable jsonb column to jobs and Extractions only', async () => {
  const directory = resolve(
    import.meta.dirname,
    '../migrations/app/20260923T1547_extraction_requested_models',
  )
  const all = JSON.parse(
    await readFile(resolve(directory, 'ops.json'), 'utf8'),
  ) as MigrationOperation[]

  assert.deepEqual(all.map((operation) => operation.id).sort(), [
    'column.public.extraction.requestedModels',
    'column.public.extractionJob.requestedModels',
  ])
  for (const operation of all) {
    assert.equal(operation.operationClass, 'additive')
    // Nullable, with no default: jobs and Extractions made before a run could choose keep kei-exp's defaults.
    assert.match(
      operation.execute?.[0]?.sql ?? '',
      /^ALTER TABLE "public"\."(?:extraction|extractionJob)" ADD COLUMN "requestedModels" jsonb$/,
    )
  }
  const migration = JSON.parse(
    await readFile(resolve(directory, 'migration.json'), 'utf8'),
  ) as { from: string }
  const previous = JSON.parse(
    await readFile(
      resolve(directory, '../20260923T1050_extraction_job_catalog_recipe/migration.json'),
      'utf8',
    ),
  ) as { to: string }
  assert.equal(migration.from, previous.to)
})
