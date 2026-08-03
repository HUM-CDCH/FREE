import { describe, expect, it } from 'vitest'
import { splitEvidenceResult, wrapTemplateWithEvidence } from './_evidence_template'

describe('wrapTemplateWithEvidence', () => {
  it('adds one _evidence sibling per schema object, keyed by that object\'s field names', () => {
    const template = {
      grave: [{ name: 'verbatim-string', depth: 'number' }],
      cemetery: { city: 'string' },
    }

    expect(wrapTemplateWithEvidence(template)).toEqual({
      grave: [
        {
          name: 'verbatim-string',
          depth: 'number',
          _evidence: {
            name: { snippet: 'string', page: 'number' },
            depth: { snippet: 'string', page: 'number' },
          },
        },
      ],
      cemetery: {
        city: 'string',
        _evidence: { city: { snippet: 'string', page: 'number' } },
      },
    })
  })

  it('declares a parallel evidence array for scalar arrays and leaves object arrays to recursion', () => {
    expect(wrapTemplateWithEvidence({ film: ['verbatim-string'], finds: [{ id: 'string' }] })).toEqual({
      film: ['verbatim-string'],
      finds: [{ id: 'string', _evidence: { id: { snippet: 'string', page: 'number' } } }],
      _evidence: { film: [{ snippet: 'string', page: 'number' }] },
    })
  })
})

describe('splitEvidenceResult', () => {
  it('hoists _evidence out of the result into a mirrored evidence tree', () => {
    const extracted = {
      grave: [
        {
          name: 'Grave 1',
          depth: 42,
          _evidence: {
            name: { snippet: 'Grave 1', page: 2 },
            depth: { snippet: '', page: 2 },
          },
        },
      ],
    }

    expect(splitEvidenceResult(extracted)).toEqual({
      result: { grave: [{ name: 'Grave 1', depth: 42 }] },
      evidence: { grave: [{ name: { value: 'Grave 1', snippet: 'Grave 1', page: 2 } }] },
    })
  })

  it('keeps evidence when the model omits the page', () => {
    const extracted = {
      grave_id: '8',
      _evidence: { grave_id: { snippet: 'Grav 8', page: null } },
    }

    expect(splitEvidenceResult(extracted)).toEqual({
      result: { grave_id: '8' },
      evidence: { grave_id: { value: '8', snippet: 'Grav 8', page: null } },
    })
  })

  it('accepts the plural snippets form', () => {
    const extracted = {
      datering: 'C3',
      _evidence: { datering: { snippets: ['Datering: Yngre romersk jernalder per. C3.'], page: 4 } },
    }

    expect(splitEvidenceResult(extracted)).toEqual({
      result: { datering: 'C3' },
      evidence: {
        datering: { value: 'C3', snippet: 'Datering: Yngre romersk jernalder per. C3.', page: 4 },
      },
    })
  })

  it('mirrors evidence element by element for scalar arrays', () => {
    const extracted = {
      film: ['22-23', '24'],
      _evidence: { film: [{ snippet: 'S/H (film 4): 22-23', page: 1 }, {}] },
    }

    expect(splitEvidenceResult(extracted)).toEqual({
      result: { film: ['22-23', '24'] },
      evidence: { film: [{ value: '22-23', snippet: 'S/H (film 4): 22-23', page: 1 }, null] },
    })
  })

  it('leaves a result without any _evidence untouched', () => {
    const extracted = { measurement: { value: '42 cm', snippet: 'recorded in trench notes', page: 12 } }

    expect(splitEvidenceResult(extracted)).toEqual({
      result: { measurement: { value: '42 cm', snippet: 'recorded in trench notes', page: 12 } },
      evidence: null,
    })
  })
})
