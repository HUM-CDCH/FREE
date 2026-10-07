import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { extractionMethodIntentSchema } from './extraction-method.js'
import { gliformerIssues, refuseIncompatibleGliformer } from './gliformer-compatibility.js'
import { parseSchemaDefinition } from './schema.js'
import { ExtractionError } from './errors.js'

const { cases } = JSON.parse(readFileSync(new URL(
  '../../../apps/parsing_service/tests/fixtures/contracts/gliformer-compatibility.json', import.meta.url), 'utf8'))

for (const item of cases) test(`GLiFormer service compatibility: ${item.id}`, () => {
  const method = extractionMethodIntentSchema.parse(item.method)
  const schema = parseSchemaDefinition(item.schema)
  const before = JSON.stringify({ method, schema })
  const issues = gliformerIssues(method, schema.schemaNodes)
  assert.equal(issues.length === 0, item.accepted)
  for (const term of item.terms) assert.ok(issues.join('; ').includes(term), term)
  if (item.accepted) refuseIncompatibleGliformer(method, schema)
  else assert.throws(() => refuseIncompatibleGliformer(method, schema), (error: unknown) =>
    error instanceof ExtractionError && error.code === 'incompatible_extraction_model' &&
    item.terms.every((term: string) => error.message.includes(term)))
  assert.equal(JSON.stringify({ method, schema }), before)
})
