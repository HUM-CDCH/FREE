import { describe, expect, it } from 'vitest'
import type { SchemaNode } from 'extraction/schema'
import { parseSchemaEditOutput, withFieldDescriptions } from './_schema_edit_output.js'

describe('schema edit output', () => {
  it('decodes notes beside the template, including NuExtract root metadata, without making them extraction fields', async () => {
    const fieldDescriptions = [{ path: ['title'], description: 'Copy the full heading.' }]
    await expect(parseSchemaEditOutput(JSON.stringify({
      template: { _description: 'One entry.', title: 'string' }, fieldDescriptions,
    }))).resolves.toEqual({ template: { _description: 'One entry.', title: 'string' }, fieldDescriptions })
    await expect(parseSchemaEditOutput(JSON.stringify({
      _description: 'One entry.', template: { title: 'string' }, fieldDescriptions,
    }))).resolves.toEqual({ template: { _description: 'One entry.', title: 'string' }, fieldDescriptions })
  })

  it('preserves old bare or enveloped templates and fields named fieldDescriptions', async () => {
    const template = { _description: 'One entry.', fieldDescriptions: ['verbatim-string'] }
    await expect(parseSchemaEditOutput(JSON.stringify(template))).resolves.toEqual({ template })
    await expect(parseSchemaEditOutput(JSON.stringify({ template }))).resolves.toEqual({ template })
  })

  it('uses exact path segments through objects and repeating objects, including dots in field names', () => {
    const nodes: SchemaNode[] = [
      { id: 'literal', name: 'item.name', type: 'string' },
      { id: 'item', name: 'item', type: 'object', children: [{ id: 'name', name: 'name', type: 'string' }] },
      { id: 'items', name: 'items', type: 'array', children: [
        { id: 'kind', name: 'kind', type: 'string', allowedValues: ['urn', 'coffin'] },
        { id: 'dates', name: 'dates', type: 'array', itemType: 'date' },
      ] },
    ]
    expect(withFieldDescriptions(nodes, [
      { path: ['item.name'], description: 'Literal dotted name.' },
      { path: ['item', 'name'], description: 'Nested name.' },
      { path: ['items', 'kind'], description: 'Choose the stated kind.' },
      { path: ['items', 'dates'], description: 'Include every date.' },
    ])).toEqual([
      { ...nodes[0], description: 'Literal dotted name.' },
      { ...nodes[1], children: [{ id: 'name', name: 'name', type: 'string', description: 'Nested name.' }] },
      { ...nodes[2], children: [
        { id: 'kind', name: 'kind', type: 'string', allowedValues: ['urn', 'coffin'], description: 'Choose the stated kind.' },
        { id: 'dates', name: 'dates', type: 'array', itemType: 'date', description: 'Include every date.' },
      ] },
    ])
    expect(nodes[0]!.description).toBeUndefined()
  })

  it('treats an absent sidecar, absent entries and null or omitted descriptions as unchanged', () => {
    const nodes: SchemaNode[] = [{ id: 'title', name: 'title', type: 'string', description: 'Keep this rule.' }]
    for (const value of [undefined, [], [{ path: ['title'], description: null }], [{ path: ['title'] }]])
      expect(withFieldDescriptions(nodes, value)).toEqual(nodes)
    expect(withFieldDescriptions(nodes, [{ path: ['title'], description: '' }])[0]!.description).toBe('')
  })

  it('decodes an explicit clear operation and maps it to the existing empty-description edit', async () => {
    const nodes: SchemaNode[] = [{ id: 'title', name: 'title', type: 'string', description: 'Remove this rule.' }]
    const output = await parseSchemaEditOutput(JSON.stringify({
      template: { _description: 'One entry.', title: 'string' },
      fieldDescriptions: [{ path: ['title'], clear: true }],
    }))
    expect(withFieldDescriptions(nodes, output.fieldDescriptions)).toEqual([{ ...nodes[0], description: '' }])
    expect(nodes[0]!.description).toBe('Remove this rule.')
  })

  it.each(['Replacement', '', null])('rejects a clear operation combined with description %j', (description) => {
    const nodes: SchemaNode[] = [{ id: 'title', name: 'title', type: 'string', description: 'Keep this rule.' }]
    expect(() => withFieldDescriptions(nodes, [{ path: ['title'], clear: true, description }]))
      .toThrow('invalid scalar field notes')
    expect(nodes[0]!.description).toBe('Keep this rule.')
  })

  it('rejects duplicate final paths instead of choosing a target', () => {
    const nodes: SchemaNode[] = [
      { id: 'one', name: 'same', type: 'string' },
      { id: 'two', name: 'same', type: 'string' },
    ]
    expect(() => withFieldDescriptions(nodes, [{ path: ['same'], description: 'Ambiguous.' }])).toThrow('invalid scalar field notes')
  })
})
