import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { it } from 'node:test'

const migrations = resolve(import.meta.dirname, '../migrations/app')
const directory = resolve(migrations, readdirSync(migrations).find(name => name.endsWith('_unified_catalog'))!)
const operations = JSON.parse(readFileSync(resolve(directory, 'ops.json'), 'utf8')) as {
  id: string; operationClass: string; execute?: { sql: string }[]
}[]

it('retires only Catalog account keys and drops only the recipe column', () => {
  assert.deepEqual(operations.filter(operation => operation.operationClass === 'destructive').map(operation => operation.id),
    ['dropColumn.extraction.catalogRecipe'])
  const transform = operations.find(operation => operation.id === 'data_migration.retire-catalog-preferences')!
  const sql = transform.execute![0]!.sql
  assert.match(sql, /jsonb_set\("document", '\{extractionSettings,catalog\}'/)
  assert.match(sql, /- 'generic' - 'recipe'/)
  assert.match(sql, /\?\| array\['generic','recipe'\]/)
  assert.doesNotMatch(sql, /DELETE|TRUNCATE|article|unified/)
})

it('keeps a schema without recordScope as a live editable state', () => {
  const end = JSON.parse(readFileSync(resolve(directory, 'end-contract.json'), 'utf8'))
  const models = end.domain.namespaces.public.models
  assert.equal(models.SchemaRevision.fields.recordScope.nullable, true)
  assert.equal(models.Extraction.fields.catalogRecipe, undefined)
})
