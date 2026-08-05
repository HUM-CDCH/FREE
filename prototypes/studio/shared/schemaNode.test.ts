import { describe, expect, it } from 'vitest'
import {
  countSchemaMetadata,
  duplicateFieldKeys,
  enumerateFieldPaths,
  nodesToTemplate,
  templateToNodes,
} from './schemaNode'

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
})
