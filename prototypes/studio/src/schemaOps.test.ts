import { describe, expect, it } from 'vitest'
import { applyOps, parseSchemaOps } from './schemaOps'
import type { SchemaNode } from './schemaNode'

describe('schema operations contract', () => {
  it('rejects a malformed operation list instead of silently dropping entries', () => {
    expect(() => parseSchemaOps([{ op: 'add', name: 'year', type: 'nonsense' }])).toThrow(/malformed/)
  })

  it('applies a patch to a deeply nested field', () => {
    const nodes: SchemaNode[] = [{ id: 'a', name: 'root', type: 'object', children: [{ id: 'b', name: 'middle', type: 'object', children: [{ id: 'c', name: 'year', type: 'string' }] }] }]
    const result = applyOps(nodes, [{ op: 'patch', name: 'year', newName: 'date', type: 'date', parentName: 'middle' }])
    expect(result[0].children?.[0].children?.[0]).toMatchObject({ name: 'date', type: 'date' })
  })

  it.each(['object', 'array'] as const)('adds %s fields as empty groups', (type) => {
    expect(applyOps([], [{ op: 'add', name: 'group', type }])[0]).toMatchObject({ type, children: [] })
  })

  it('converts scalars to empty groups and populated groups to clean scalars', () => {
    const scalar: SchemaNode[] = [{ id: 'a', name: 'field', type: 'string' }]
    expect(applyOps(scalar, [{ op: 'patch', name: 'field', type: 'object' }])[0]).toMatchObject({ type: 'object', children: [] })
    const group: SchemaNode[] = [{ id: 'a', name: 'field', type: 'object', description: 'group only', children: [{ id: 'b', name: 'child', type: 'string' }] }]
    expect(applyOps(group, [{ op: 'patch', name: 'field', type: 'integer' }])[0]).toEqual({ id: 'a', name: 'field', type: 'integer' })
  })
})
