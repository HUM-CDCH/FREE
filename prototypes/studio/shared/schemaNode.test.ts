import { describe, expect, it } from 'vitest'
import {
  countSchemaMetadata,
  duplicateFieldKeys,
  enumerateFieldPaths,
  nodesToTemplate,
  parseSchemaNodes,
  templateToNodes,
  type SchemaNode,
} from './schemaNode'

// @ts-expect-error Closed-set values are valid only on string fields.
const invalidClosedSetNode: SchemaNode = { id: 'count', name: 'count', type: 'number', allowedValues: ['one', 'two'] }
void invalidClosedSetNode

describe('SchemaNode conversion', () => {
  it('round-trips closed sets, repeating groups, and repeating string lists', () => {
    const template = {
      names: ['string'],
      gender: ['woman', 'man', 'unknown'],
      graves: [{ material: 'string' }],
    }

    const nodes = templateToNodes(template)

    expect(nodes[0]).toMatchObject({ name: 'names', type: 'array' })
    expect(nodes[0].children).toBeUndefined()
    expect(nodes[1]).toMatchObject({ name: 'gender', type: 'string', allowedValues: template.gender })
    expect(nodes[2]).toMatchObject({ name: 'graves', type: 'array', children: [expect.any(Object)] })
    expect(nodesToTemplate(nodes)).toEqual(template)
  })

  it('round-trips a repeating scalar field without changing its item type', () => {
    const template = { dates: ['date'] }

    expect(nodesToTemplate(templateToNodes(template))).toEqual(template)
  })

  it('enumerates nodes without exposing descriptions or allowed-value members', () => {
    const nodes = templateToNodes({
      place: { _description: 'Researcher-authored rule', region: ['north', 'south'] },
    })

    expect(enumerateFieldPaths(nodes).map(({ key }) => key)).toEqual(['place', 'place.region'])
    expect(countSchemaMetadata(nodes)).toEqual({ descriptions: 1, allowedValues: 1 })
  })

  it('reports duplicate opaque keys', () => {
    const duplicate = [
      { id: 'a', name: 'same', type: 'string' },
      { id: 'b', name: 'same', type: 'number' },
    ]

    expect(duplicateFieldKeys(enumerateFieldPaths(duplicate))).toEqual(['same'])
  })

  it('refuses to serialize duplicate sibling field names', () => {
    const duplicate = [
      { id: 'a', name: 'same', type: 'string' },
      { id: 'b', name: 'same', type: 'number' },
    ]

    expect(() => nodesToTemplate(duplicate)).toThrow('Duplicate field name: same')
  })

  it('validates recursive ordered nodes without changing sibling order', () => {
    const stored = [
      { id: 'z', name: 'zeta', type: 'string' },
      {
        id: 'g',
        name: 'group',
        type: 'object',
        children: [
          { id: 'b', name: 'beta', type: 'number' },
          { id: 'a', name: 'alpha', type: 'string' },
        ],
      },
      { id: 'a2', name: 'alpha', type: 'boolean' },
    ]

    expect(parseSchemaNodes(stored)).toEqual(stored)
    expect(Object.keys(nodesToTemplate(parseSchemaNodes(stored)))).toEqual([
      'zeta',
      'group',
      'alpha',
    ])
    expect(
      Object.keys(
        nodesToTemplate(parseSchemaNodes(stored)).group as Record<
          string,
          unknown
        >,
      ),
    ).toEqual(['beta', 'alpha'])
  })

  it('rejects an obsolete object-shaped stored schema', () => {
    expect(() => parseSchemaNodes({ zeta: 'string' })).toThrow()
  })
})
