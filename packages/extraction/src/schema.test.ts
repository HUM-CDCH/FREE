import assert from 'node:assert/strict'
import test from 'node:test'
import { parseBatchSuggestionDefinition, parseSchemaDefinition, templateToSchemaDefinition, type SchemaNode } from './schema.js'

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

test('a suggested template takes its notes onto the scalar fields their exact paths name, and ignores the rest', () => {
  const parsed = templateToSchemaDefinition(
    { _description: 'One entry.', title: 'string', status: ['open', 'closed'], refs: ['string'], items: [{ _description: 'One item.', name: 'string' }] },
    [
      { path: ['title'], description: ' The entry heading. ' },
      { path: ['status'], description: 'Whether the entry is open.' },
      { path: ['refs'], description: 'Each cited work.' },
      { path: ['items', 'name'], description: 'The item name.' },
      { path: ['items'], description: 'A group keeps its own _description.' },
      { path: ['missing'], description: 'No such field.' },
      { path: ['name'], description: 'Not the nested name.' },
    ],
  )
  const notes = (nodes: readonly SchemaNode[]): unknown[] =>
    nodes.map((node) => [node.name, node.description, node.descriptionSource, ...(node.children ? [notes(node.children)] : [])])
  const reloaded = parseSchemaDefinition(JSON.parse(JSON.stringify(parsed)))
  assert.deepEqual(notes(reloaded.schemaNodes), [
    ['title', 'The entry heading.', 'suggested'],
    ['status', 'Whether the entry is open.', 'suggested'],
    ['refs', 'Each cited work.', 'suggested'],
    ['items', 'One item.', 'suggested', [['name', 'The item name.', 'suggested']]],
  ])
})
