import { describe, expect, it } from 'vitest'
import type { SchemaNode } from 'extraction/schema'
import { moveSchemaNodes, schemaDragMode } from './schemaEditorTree'

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
