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

  // A group's valueSource and evidencePolicy decide what the next Extraction reads and how its Evidence is assessed.
  const withMetadata: SchemaNode[] = [
    { id: 'g', name: 'grave', type: 'object', description: 'One grave.', valueSource: 'document', evidencePolicy: 'derived',
      children: [{ id: 'g1', name: 'depth', type: 'number' }, { id: 'g2', name: 'width', type: 'number' }] },
    { id: 't', name: 'title', type: 'string' },
  ]
  it('returns the original tree, the surviving parent group\'s extraction metadata included', () => {
    const [removed, without] = removeSchemaNode(withMetadata, 'g1')
    expect(restoreSchemaNode(without, removed!, 'g', 0)).toStrictEqual(withMetadata)
  })
  it('keeps fields added meanwhile, in the group and beside it', () => {
    const [removed, without] = removeSchemaNode(withMetadata, 'g1')
    const [group, title] = without
    const edited: SchemaNode[] = [
      { ...group!, children: [...group!.children!, { id: 'g3', name: 'length', type: 'number' }] } as SchemaNode,
      title!,
      { id: 'n', name: 'note', type: 'string' },
    ]
    expect(restoreSchemaNode(edited, removed!, 'g', 0)).toStrictEqual([
      { ...withMetadata[0], children: [{ id: 'g1', name: 'depth', type: 'number' }, { id: 'g2', name: 'width', type: 'number' },
        { id: 'g3', name: 'length', type: 'number' }] },
      withMetadata[1],
      { id: 'n', name: 'note', type: 'string' },
    ])
  })
})

describe('moving into a group keeps the group', () => {
  it('a field dropped into a group with extraction metadata leaves that metadata in place', () => {
    const nodes: SchemaNode[] = [
      { id: 'g', name: 'grave', type: 'object', valueSource: 'document', evidencePolicy: 'quoted', children: [field('depth')] },
      field('title'),
    ]
    expect(moveSchemaNodes(nodes, { id: 'title', parentId: null, isGroup: false }, { type: 'group', id: 'g' }, 0, 30))
      .toStrictEqual([{ ...nodes[0], children: [field('depth'), field('title')] }])
  })
  it('a field dropped onto a scalar with allowed values makes it a group without them', () => {
    const nodes: SchemaNode[] = [
      { id: 'sex', name: 'sex', type: 'string', allowedValues: ['f', 'm'], evidencePolicy: 'quoted' },
      field('title'),
    ]
    expect(moveSchemaNodes(nodes, { id: 'title', parentId: null, isGroup: false }, { type: 'group', id: 'sex' }, 0, 30))
      .toStrictEqual([{ id: 'sex', name: 'sex', type: 'object', evidencePolicy: 'quoted', children: [field('title')] }])
  })
  it('a field dropped onto a scalar read from the file name makes a group without that value source', () => {
    // A scalar's valueSource says where its one value comes from; a new group has no value of its own to read.
    const nodes: SchemaNode[] = [
      { id: 'file', name: 'file', type: 'string', valueSource: 'source-filename', description: 'The scan.' },
      field('title'),
    ]
    expect(moveSchemaNodes(nodes, { id: 'title', parentId: null, isGroup: false }, { type: 'group', id: 'file' }, 0, 30))
      .toStrictEqual([{ id: 'file', name: 'file', type: 'object', description: 'The scan.', children: [field('title')] }])
  })
  it('a group that already was one keeps its value source when a field is dropped into it', () => {
    const nodes: SchemaNode[] = [
      { id: 'g', name: 'grave', type: 'object', valueSource: 'document', children: [field('depth')] },
      field('title'),
    ]
    expect(moveSchemaNodes(nodes, { id: 'title', parentId: null, isGroup: false }, { type: 'group', id: 'g' }, 0, 30))
      .toStrictEqual([{ ...nodes[0], children: [field('depth'), field('title')] }])
  })
})
