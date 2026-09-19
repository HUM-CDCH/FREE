import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { schemaDefinitionSchema } from './schema.js'

const definition = (schemaNodes: unknown[]) => ({
  recordDescription: 'A test record.',
  schemaNodes,
})

describe('SchemaNode identifying/evaluationTolerance', () => {
  it('accepts identifying on any field type', () => {
    const parsed = schemaDefinitionSchema.parse(
      definition([
        { id: 'species', name: 'species', type: 'string', identifying: true },
        { id: 'count', name: 'count', type: 'integer', identifying: true },
      ]),
    )
    assert.equal(parsed.schemaNodes[0]?.identifying, true)
    assert.equal(parsed.schemaNodes[1]?.identifying, true)
  })

  it('defaults identifying to unset', () => {
    const parsed = schemaDefinitionSchema.parse(
      definition([{ id: 'species', name: 'species', type: 'string' }]),
    )
    assert.equal(parsed.schemaNodes[0]?.identifying, undefined)
  })

  it('accepts an absolute evaluationTolerance on a number field', () => {
    const parsed = schemaDefinitionSchema.parse(
      definition([
        {
          id: 'temp',
          name: 'temperature',
          type: 'number',
          evaluationTolerance: { kind: 'absolute', amount: 0.5 },
        },
      ]),
    )
    assert.deepEqual(parsed.schemaNodes[0]?.evaluationTolerance, {
      kind: 'absolute',
      amount: 0.5,
    })
  })

  it('accepts a relative evaluationTolerance on an integer field', () => {
    const parsed = schemaDefinitionSchema.parse(
      definition([
        {
          id: 'count',
          name: 'count',
          type: 'integer',
          evaluationTolerance: { kind: 'relative', fraction: 0.1 },
        },
      ]),
    )
    assert.deepEqual(parsed.schemaNodes[0]?.evaluationTolerance, {
      kind: 'relative',
      fraction: 0.1,
    })
  })

  it('rejects evaluationTolerance on a string field', () => {
    assert.throws(() =>
      schemaDefinitionSchema.parse(
        definition([
          {
            id: 'species',
            name: 'species',
            type: 'string',
            evaluationTolerance: { kind: 'absolute', amount: 1 },
          },
        ]),
      ),
    )
  })

  it('rejects evaluationTolerance on a boolean field', () => {
    assert.throws(() =>
      schemaDefinitionSchema.parse(
        definition([
          {
            id: 'flag',
            name: 'flag',
            type: 'boolean',
            evaluationTolerance: { kind: 'absolute', amount: 1 },
          },
        ]),
      ),
    )
  })

  it('numeric fields default to exact match (no tolerance) when unset', () => {
    const parsed = schemaDefinitionSchema.parse(
      definition([{ id: 'temp', name: 'temperature', type: 'number' }]),
    )
    assert.equal(parsed.schemaNodes[0]?.evaluationTolerance, undefined)
  })
})
