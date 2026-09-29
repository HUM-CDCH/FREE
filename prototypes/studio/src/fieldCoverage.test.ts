import type { SchemaNode } from 'extraction/schema'
import { describe, expect, it } from 'vitest'
import { countLeafFields, leafFields } from './fieldCoverage'

const scalar = (name: string): SchemaNode => ({ id: name, name, type: 'string' })

describe('leafFields', () => {
  it('counts every declared leaf whatever its name, including nested and repeated ones', () => {
    const schema: SchemaNode[] = [
      scalar('title'),
      scalar('evidence'),
      scalar('_catalogue_id'),
      { id: 'internal', name: 'internal', type: 'object', children: [scalar('Evidence'), scalar('page')] },
      { id: 'entries', name: '_entries', type: 'array', children: [scalar('evidence'), scalar('internal')] },
    ]

    expect(leafFields(schema).map((field) => field.path)).toEqual([
      ['title'],
      ['evidence'],
      ['_catalogue_id'],
      ['internal', 'Evidence'],
      ['internal', 'page'],
      ['_entries', 'evidence'],
      ['_entries', 'internal'],
    ])
    expect(countLeafFields(schema)).toBe(7)
    expect(countLeafFields(null)).toBe(0)
  })
})
