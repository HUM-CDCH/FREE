import { describe, expect, it } from 'vitest'
import { conformToSchema, parseExtractionResult } from './_model_output.js'

describe('conformToSchema pinned parity', () => {
  it('drops unknown keys and restores missing nested values', () => {
    expect(
      conformToSchema(
        { title: 'Report', nested: { extra: 'drop' }, extra: true },
        { title: '', count: 0, nested: { value: '' }, rows: [{ id: '' }] },
      ),
    ).toEqual({
      title: 'Report',
      count: null,
      nested: { value: null },
      rows: [],
    })
  })

  it('recovers singleton arrays and nulls incompatible scalar containers', () => {
    expect(
      conformToSchema({ rows: { id: 'one' }, label: ['not', 'scalar'] }, { rows: [{ id: '' }], label: '' }),
    ).toEqual({ rows: [{ id: 'one' }], label: null })
  })

  it('keeps empty object and array schemas free-form', () => {
    expect(conformToSchema({ object: { any: ['shape'] }, array: [{ any: true }] }, { object: {}, array: [] })).toEqual({
      object: { any: ['shape'] },
      array: [{ any: true }],
    })
  })

  it('uses empty free-form containers for incompatible values', () => {
    expect(conformToSchema({ object: 'no', array: null }, { object: {}, array: [] })).toEqual({
      object: {},
      array: [],
    })
  })

  it('conforms repaired model JSON instead of leaking extra fields', async () => {
    await expect(
      parseExtractionResult('{"title":"Report","extra":"drop"}', {
        title: '',
        count: 0,
      }),
    ).resolves.toEqual({ title: 'Report', count: null })
  })
})
