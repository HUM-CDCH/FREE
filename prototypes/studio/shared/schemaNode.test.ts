import { describe, expect, it, vi } from 'vitest'
import {
  countSchemaMetadata,
  duplicateFieldKeys,
  enumerateFieldPaths,
  nodesToTemplate,
  partitionSchemaNodes,
  parseSchemaDefinition,
  parseSchemaNodes,
  restoreSchemaNodeOrder,
  schemaDefinitionToTemplate,
  schemaNodesToZod,
  templateToSchemaDefinition,
  templateToNodes,
  type SchemaNode,
} from 'extraction/schema'

// @ts-expect-error Closed-set values are valid only on string fields.
const invalidClosedSetNode: SchemaNode = { id: 'count', name: 'count', type: 'number', allowedValues: ['one', 'two'] }
void invalidClosedSetNode

describe('SchemaNode conversion', () => {
  it('does not reuse generated node ids after a module reload', async () => {
    vi.resetModules()
    const firstModule = await import('extraction/schema')
    const firstId = firstModule.mkId()
    vi.resetModules()
    const secondModule = await import('extraction/schema')

    expect(secondModule.mkId()).not.toBe(firstId)
  })

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
    const duplicate: SchemaNode[] = [
      { id: 'a', name: 'same', type: 'string' },
      { id: 'b', name: 'same', type: 'number' },
    ]

    expect(duplicateFieldKeys(enumerateFieldPaths(duplicate))).toEqual(['same'])
  })

  it('does not confuse dotted field names with nested paths', () => {
    const nodes: SchemaNode[] = [
      { id: 'flat', name: 'place.region', type: 'string' },
      {
        id: 'place',
        name: 'place',
        type: 'object',
        children: [{ id: 'nested', name: 'region', type: 'string' }],
      },
    ]

    const fields = enumerateFieldPaths(nodes)
    expect(fields.map(({ key }) => key)).toEqual([
      'place\\.region',
      'place',
      'place.region',
    ])
    expect(duplicateFieldKeys(fields)).toEqual([])
  })

  it('refuses to serialize duplicate sibling field names', () => {
    const duplicate: SchemaNode[] = [
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

  it('round-trips the explicit root record description separately from fields', () => {
    const template = {
      _description: 'One top-level numbered research article section.',
      sectionNumber: 'integer',
      sectionTitle: 'string',
    }

    const definition = templateToSchemaDefinition(template)

    expect(definition.recordDescription).toBe(
      'One top-level numbered research article section.',
    )
    expect(definition.schemaNodes.map((node) => node.name)).toEqual([
      'sectionNumber',
      'sectionTitle',
    ])
    expect(schemaDefinitionToTemplate(definition)).toEqual(template)
    expect(parseSchemaDefinition(definition)).toEqual(definition)
  })

  it('rejects a schema without an explicit root record description', () => {
    expect(() => templateToSchemaDefinition({ title: 'string' })).toThrow(
      'record description',
    )
    expect(() =>
      parseSchemaDefinition({ recordDescription: '', schemaNodes: [] }),
    ).toThrow()
  })

  it('accepts top-level value sources and rejects nested declarations', () => {
    expect(parseSchemaNodes([
      { id: 'title', name: 'title', type: 'string', valueSource: 'document' },
    ])).toEqual([
      { id: 'title', name: 'title', type: 'string', valueSource: 'document' },
    ])
    expect(() => parseSchemaNodes({ zeta: 'string' })).toThrow()
    expect(() =>
      parseSchemaNodes([
        {
          id: 'group',
          name: 'group',
          type: 'object',
          children: [
            { id: 'title', name: 'title', type: 'string', valueSource: 'document' },
          ],
        },
      ]),
    ).toThrow()
  })

  it('partitions complete top-level subtrees and restores model order', () => {
    const nodes = parseSchemaNodes([
      { id: 'title', name: 'title', type: 'string' },
      {
        id: 'details',
        name: 'details',
        type: 'object',
        valueSource: 'document',
        children: [{ id: 'year', name: 'year', type: 'integer' }],
      },
      { id: 'filename', name: 'filename', type: 'string', valueSource: 'source-filename' },
    ])
    expect(partitionSchemaNodes(nodes)).toEqual({
      documentNodes: [nodes[1]],
      recordNodes: [nodes[0]],
      packageNodes: [nodes[2]],
    })
    expect(restoreSchemaNodeOrder(
      { details: { year: 2026 }, title: 'A title' },
      [...partitionSchemaNodes(nodes).recordNodes, ...partitionSchemaNodes(nodes).documentNodes],
    )).toEqual({ title: 'A title', details: { year: 2026 } })
    expect(() => restoreSchemaNodeOrder({ title: 'A title', unknown: true }, nodes)).toThrow('Unexpected model key')
    expect(restoreSchemaNodeOrder(
      { title: 'A title', details: { year: 2026, unknown: true } },
      nodes,
      { ignoreUnknownKeys: true },
    )).toEqual({ title: 'A title', details: { year: 2026 } })
  })
})

describe('schemaNodesToZod', () => {
  it('accepts every scalar field type and rejects a type mismatch', () => {
    const nodes: SchemaNode[] = [
      { id: 'a', name: 'title', type: 'string' },
      { id: 'b', name: 'quote', type: 'verbatim-string' },
      { id: 'c', name: 'when', type: 'date' },
      { id: 'd', name: 'count', type: 'number' },
      { id: 'e', name: 'year', type: 'integer' },
      { id: 'f', name: 'active', type: 'boolean' },
    ]
    const schema = schemaNodesToZod(nodes)

    expect(schema.safeParse({
      title: 'A title',
      quote: 'Exact wording',
      when: '1901-01-01',
      count: 3.5,
      year: 1901,
      active: true,
    }).success).toBe(true)
    expect(schema.safeParse({ title: 42 }).success).toBe(false)
    expect(schema.safeParse({ year: 'not a number' }).success).toBe(false)
  })

  it('maps allowedValues to a closed enum', () => {
    const nodes: SchemaNode[] = [
      { id: 'a', name: 'gender', type: 'string', allowedValues: ['woman', 'man', 'unknown'] },
    ]
    const schema = schemaNodesToZod(nodes)

    expect(schema.safeParse({ gender: 'man' }).success).toBe(true)
    expect(schema.safeParse({ gender: 'other' }).success).toBe(false)
  })

  it('rejects a model key that is not declared in the schema', () => {
    const nodes: SchemaNode[] = [{ id: 'a', name: 'title', type: 'string' }]
    const schema = schemaNodesToZod(nodes)

    expect(schema.safeParse({ title: 'A title', description: 'Extra' }).success).toBe(false)
  })

  it('tolerates omitted and null values without forcing fabrication', () => {
    const nodes: SchemaNode[] = [
      { id: 'a', name: 'title', type: 'string' },
      { id: 'b', name: 'subtitle', type: 'string' },
    ]
    const schema = schemaNodesToZod(nodes)

    expect(schema.safeParse({ title: 'A title' }).success).toBe(true)
    expect(schema.safeParse({ title: 'A title', subtitle: null }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(true)
  })

  it('constrains a repeating scalar array by item type', () => {
    const nodes: SchemaNode[] = [{ id: 'a', name: 'names', type: 'array', itemType: 'string' }]
    const schema = schemaNodesToZod(nodes)

    expect(schema.safeParse({ names: ['Alpha', 'Beta'] }).success).toBe(true)
    expect(schema.safeParse({ names: [1, 2] }).success).toBe(false)
  })

  it('constrains a repeating group and rejects an unexpected key inside it', () => {
    const nodes: SchemaNode[] = [
      {
        id: 'a',
        name: 'graves',
        type: 'array',
        children: [{ id: 'b', name: 'material', type: 'string' }],
      },
    ]
    const schema = schemaNodesToZod(nodes)

    expect(schema.safeParse({ graves: [{ material: 'Stone' }] }).success).toBe(true)
    expect(schema.safeParse({ graves: [{ material: 'Stone', description: 'Extra' }] }).success).toBe(false)
  })

  it('derives a schema that accepts any template produced by nodesToTemplate, round-tripped through templateToNodes', () => {
    const template = {
      names: ['string'],
      gender: ['woman', 'man', 'unknown'],
      graves: [{ material: 'string' }],
      dates: ['date'],
    }
    const nodes = templateToNodes(template)
    const schema = schemaNodesToZod(nodes)

    expect(schema.safeParse({
      names: ['Alpha'],
      gender: 'woman',
      graves: [{ material: 'Stone' }],
      dates: ['1901-01-01'],
    }).success).toBe(true)
    expect(schema.safeParse({
      names: ['Alpha'],
      gender: 'woman',
      graves: [{ material: 'Stone' }],
      dates: ['1901-01-01'],
      description: 'Extra',
    }).success).toBe(false)
  })
})
