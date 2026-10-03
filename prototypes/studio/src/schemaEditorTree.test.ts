import { describe, expect, it } from 'vitest'
import type { SchemaNode } from 'extraction/schema'
import { moveSchemaNodes, removeSchemaNode, restoreSchemaNode, schemaDragMode } from './schemaEditorTree'

const field = (id: string): SchemaNode => ({ id, name: id, type: 'string' })
const group = (id: string, children: SchemaNode[]): SchemaNode => ({
  id,
  name: id,
  type: 'object',
  children,
})

describe('schema editor drag geometry', () => {
  it('classifies horizontal intent without treating diagonal movement as indenting', () => {
    expect(schemaDragMode(49, 0)).toBe('indent')
    expect(schemaDragMode(-49, 0)).toBe('outdent')
    expect(schemaDragMode(100, 20)).toBe('normal')
    expect(schemaDragMode(48, 0)).toBe('normal')
  })

  it('reorders within one level using the pre-removal slot index', () => {
    const nodes = [field('a'), field('b'), field('c')]
    expect(
      moveSchemaNodes(
        nodes,
        { id: 'a', parentId: null, isGroup: false },
        { type: 'slot', parentId: null, index: 3 },
        0,
        30,
      )?.map(({ id }) => id),
    ).toEqual(['b', 'c', 'a'])
  })

  it('indents into the previous sibling while preserving scalar-array repetition', () => {
    const array: SchemaNode = {
      id: 'dates',
      name: 'dates',
      type: 'array',
      itemType: 'date',
    }
    const moved = moveSchemaNodes(
      [array, field('title')],
      { id: 'title', parentId: null, isGroup: false },
      null,
      60,
      0,
    )
    expect(moved).toEqual([
      {
        id: 'dates',
        name: 'dates',
        type: 'array',
        children: [field('title')],
      },
    ])
  })

  it('outdents after its parent when no explicit grandparent slot is active', () => {
    const nodes = [group('outer', [group('inner', [field('leaf')])])]
    const moved = moveSchemaNodes(
      nodes,
      { id: 'leaf', parentId: 'inner', isGroup: false },
      null,
      -60,
      0,
    )
    expect(moved).toEqual([
      group('outer', [group('inner', []), field('leaf')]),
    ])
  })

  it('rejects dropping a group into its own contents without losing any node', () => {
    const nodes = [group('outer', [group('inner', [field('leaf')])])]
    expect(
      moveSchemaNodes(
        nodes,
        { id: 'outer', parentId: null, isGroup: true },
        { type: 'group', id: 'inner' },
        0,
        30,
      ),
    ).toBeNull()
    expect(nodes).toEqual([group('outer', [group('inner', [field('leaf')])])])
  })
})

describe('restoreSchemaNode', () => {
  const tree: SchemaNode[] = [
    { id: 'g', name: 'grave', type: 'object', children: [{ id: 'g1', name: 'depth', type: 'number' }, { id: 'g2', name: 'width', type: 'number' }] },
    { id: 't', name: 'title', type: 'string' },
  ]
  it('puts a removed node back under its parent at its index', () => {
    const [removed, without] = removeSchemaNode(tree, 'g1')
    expect(restoreSchemaNode(without, removed!, 'g', 0)![0]!.children!.map((node) => node.id)).toEqual(['g1', 'g2'])
    const [root, rest] = removeSchemaNode(tree, 't')
    expect(restoreSchemaNode(rest, root!, null, 1)!.map((node) => node.id)).toEqual(['g', 't'])
  })
  it('is null when the parent no longer exists', () => {
    const [removed, without] = removeSchemaNode(tree, 'g1')
    const [, withoutGroup] = removeSchemaNode(without, 'g')
    expect(restoreSchemaNode(withoutGroup, removed!, 'g', 0)).toBeNull()
  })
  it('is null when the parent was retyped to a scalar', () => {
    const [removed, without] = removeSchemaNode(tree, 'g1')
    const retyped = without.map((node) => (node.id === 'g' ? { id: 'g', name: 'grave', type: 'string' as const } : node))
    expect(restoreSchemaNode(retyped, removed!, 'g', 0)).toBeNull()
  })
})
