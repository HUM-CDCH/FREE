import assert from 'node:assert/strict'
import test from 'node:test'
import { parseBatchSuggestionDefinition, parseSchemaDefinition, type SchemaNode } from './schema.js'

const definition = (schemaNodes: SchemaNode[]) => ({ recordDescription: 'One record.', schemaNodes })
const scalar = (name: string): SchemaNode => ({ id: name, name, type: 'string' })

test('batch suggestions accept every field name ordinary schema validation accepts', () => {
  for (const name of ['page', 'pages', 'evidence', 'Evidence', 'snippet', 'bbox', 'fuzzyMatches', 'occurrence_id', '_catalogue_id', 'internal', '頁']) {
    const nested = definition([
      scalar(name),
      { id: 'group', name: 'group', type: 'object', children: [{ ...scalar(name), id: `${name}-nested` }] },
    ])
    assert.deepEqual(parseSchemaDefinition(nested), nested, `ordinary validation rejects ${name}`)
    assert.deepEqual(parseBatchSuggestionDefinition(nested), nested, `batch validation rejects ${name}`)
  }
})

test('batch suggestions still reject repeated sibling names at every depth', () => {
  assert.throws(
    () => parseBatchSuggestionDefinition(definition([scalar('title'), { ...scalar('title'), id: 'again' }])),
    /cannot repeat field name title/,
  )
  assert.throws(
    () => parseBatchSuggestionDefinition(definition([
      { id: 'group', name: 'group', type: 'object', children: [scalar('page'), { ...scalar('page'), id: 'again' }] },
    ])),
    /cannot repeat field name page/,
  )
})

test('batch suggestions keep the ordinary shape checks', () => {
  assert.throws(() => parseBatchSuggestionDefinition(definition([{ ...scalar('title'), name: '  ' }])))
  assert.throws(() => parseBatchSuggestionDefinition({ recordDescription: '', schemaNodes: [scalar('title')] }))
})
