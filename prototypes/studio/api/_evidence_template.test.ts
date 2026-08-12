import { describe, expect, it } from 'vitest'
import { attachEvidenceSourceScope, splitEvidenceResult, wrapTemplateWithEvidence } from './_evidence_template'

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

  it('passes "_description" through untouched instead of wrapping it as a field', () => {
    const template = {
      cemetery: { _description: 'Only the excavation cemetery, not modern place names.', city: 'string' },
    }

    expect(wrapTemplateWithEvidence(template)).toEqual({
      cemetery: {
        _description: 'Only the excavation cemetery, not modern place names.',
        city: 'string',
        _evidence: { city: { snippet: 'string', page: 'number' } },
      },
    })
  })

  it('drops "_strategy" entirely instead of passing it through like "_description"', () => {
    const template = {
      _strategy: 'catalog',
      entries: [{ name: 'verbatim-string' }],
    }

    expect(wrapTemplateWithEvidence(template)).toEqual({
      entries: [{ name: 'verbatim-string', _evidence: { name: { snippet: 'string', page: 'number' } } }],
    })
  })

  it('leaves the extraction schema leaf shape unchanged when hasTables is false or omitted', () => {
    const template = { grave: { depth: 'number' } }

    expect(wrapTemplateWithEvidence(template)).toEqual(wrapTemplateWithEvidence(template, false))
    expect(wrapTemplateWithEvidence(template, false)).toEqual({
      grave: { depth: 'number', _evidence: { depth: { snippet: 'string', page: 'number' } } },
    })
  })

  it('adds row_header/column_header slots to _evidence leaves when hasTables is true', () => {
    const template = {
      grave: [{ name: 'verbatim-string', depth: 'number' }],
      cemetery: { city: 'string' },
    }

    expect(wrapTemplateWithEvidence(template, true)).toEqual({
      grave: [
        {
          name: 'verbatim-string',
          depth: 'number',
          _evidence: {
            name: { snippet: 'string', page: 'number', row_header: 'string', column_header: 'string' },
            depth: { snippet: 'string', page: 'number', row_header: 'string', column_header: 'string' },
          },
        },
      ],
      cemetery: {
        city: 'string',
        _evidence: { city: { snippet: 'string', page: 'number', row_header: 'string', column_header: 'string' } },
      },
    })
  })
})

describe('splitEvidenceResult', () => {
  it('attaches parser-derived scope to nested evidence without changing result values', () => {
    const split = splitEvidenceResult({ grave: [{ name: { value: 'Grave 1', snippet: 'Grave 1', page: 2 } }] })

    expect(
      attachEvidenceSourceScope(split.evidence, {
        segment_id: 'catalog:3',
        markdown_start: 10,
        markdown_end: 30,
        start_page: 2,
        end_page: 2,
      }),
    ).toEqual({
      grave: [
        {
          name: {
            value: 'Grave 1',
            snippet: 'Grave 1',
            page: 2,
            row_header: null,
            column_header: null,
            source_scope: {
              segment_id: 'catalog:3',
              markdown_start: 10,
              markdown_end: 30,
              start_page: 2,
              end_page: 2,
            },
          },
        },
      ],
    })
    expect(split.result).toEqual({ grave: [{ name: 'Grave 1' }] })
  })

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
      evidence: {
        grave: [{ name: { value: 'Grave 1', snippet: 'Grave 1', page: 2, row_header: null, column_header: null } }],
      },
    })
  })

  it('keeps evidence when the model omits the page', () => {
    const extracted = {
      grave_id: '8',
      _evidence: { grave_id: { snippet: 'Grav 8', page: null } },
    }

    expect(splitEvidenceResult(extracted)).toEqual({
      result: { grave_id: '8' },
      evidence: { grave_id: { value: '8', snippet: 'Grav 8', page: null, row_header: null, column_header: null } },
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
        datering: {
          value: 'C3',
          snippet: 'Datering: Yngre romersk jernalder per. C3.',
          page: 4,
          row_header: null,
          column_header: null,
        },
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
      evidence: {
        film: [{ value: '22-23', snippet: 'S/H (film 4): 22-23', page: 1, row_header: null, column_header: null }, null],
      },
    })
  })

  it('splits legacy inline evidence leaves', () => {
    const extracted = { measurement: { value: '42 cm', snippet: 'recorded in trench notes', page: 12 } }

    expect(splitEvidenceResult(extracted)).toEqual({
      result: { measurement: '42 cm' },
      evidence: {
        measurement: {
          value: '42 cm',
          snippet: 'recorded in trench notes',
          page: 12,
          row_header: null,
          column_header: null,
        },
      },
    })
  })

  it('drops "_description" from the extraction result instead of echoing it back', () => {
    const extracted = {
      cemetery: {
        _description: 'Only the excavation cemetery, not modern place names.',
        city: { value: 'Ribe', snippet: 'Ribe', page: 3 },
      },
    }

    expect(splitEvidenceResult(extracted)).toEqual({
      result: { cemetery: { city: 'Ribe' } },
      evidence: {
        cemetery: { city: { value: 'Ribe', snippet: 'Ribe', page: 3, row_header: null, column_header: null } },
      },
    })
  })

  it('drops "_strategy" from the extraction result instead of echoing it back', () => {
    const extracted = {
      _strategy: 'catalog',
      entries: [{ name: { value: 'Grave 1', snippet: 'Grave 1', page: 1 } }],
    }

    expect(splitEvidenceResult(extracted)).toEqual({
      result: { entries: [{ name: 'Grave 1' }] },
      evidence: {
        entries: [{ name: { value: 'Grave 1', snippet: 'Grave 1', page: 1, row_header: null, column_header: null } }],
      },
    })
  })

  it('carries row_header/column_header through when the model provides them in inline evidence', () => {
    const extracted = {
      grave: [
        {
          depth: {
            value: '42 cm',
            snippet: '42 cm',
            page: 2,
            row_header: 'Grave 1',
            column_header: 'Depth',
          },
        },
      ],
    }

    expect(splitEvidenceResult(extracted)).toEqual({
      result: { grave: [{ depth: '42 cm' }] },
      evidence: {
        grave: [
          { depth: { value: '42 cm', snippet: '42 cm', page: 2, row_header: 'Grave 1', column_header: 'Depth' } },
        ],
      },
    })
  })

  it('carries row_header/column_header through when the model provides them in _evidence', () => {
    const extracted = {
      grave: [
        {
          depth: '42 cm',
          _evidence: {
            depth: { snippet: '42 cm', page: 2, row_header: 'Grave 1', column_header: 'Depth' },
          },
        },
      ],
    }

    expect(splitEvidenceResult(extracted)).toEqual({
      result: { grave: [{ depth: '42 cm' }] },
      evidence: {
        grave: [
          { depth: { value: '42 cm', snippet: '42 cm', page: 2, row_header: 'Grave 1', column_header: 'Depth' } },
        ],
      },
    })
  })

  it('defaults row_header/column_header to null when the model omits them', () => {
    const extracted = {
      grave: [{ name: { value: 'Grave 1', snippet: 'Grave 1', page: 2 } }],
    }

    expect(splitEvidenceResult(extracted)).toEqual({
      result: { grave: [{ name: 'Grave 1' }] },
      evidence: {
        grave: [{ name: { value: 'Grave 1', snippet: 'Grave 1', page: 2, row_header: null, column_header: null } }],
      },
    })
  })
})
