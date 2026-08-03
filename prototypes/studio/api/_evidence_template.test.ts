import { describe, expect, it } from 'vitest'
import { attachEvidenceSourceScope, splitEvidenceResult, wrapTemplateWithEvidence } from './_evidence_template'

describe('wrapTemplateWithEvidence', () => {
  it('wraps every scalar extraction schema field with inline evidence fields', () => {
    const template = {
      grave: [{ name: 'verbatim-string', depth: 'number' }],
      cemetery: { city: 'string' },
    }

    expect(wrapTemplateWithEvidence(template)).toEqual({
      grave: [
        {
          name: { value: 'verbatim-string', snippet: 'string', page: 'number' },
          depth: { value: 'number', snippet: 'string', page: 'number' },
        },
      ],
      cemetery: { city: { value: 'string', snippet: 'string', page: 'number' } },
    })
  })

  it('passes "_description" through untouched instead of wrapping it as a field', () => {
    const template = {
      cemetery: { _description: 'Only the excavation cemetery, not modern place names.', city: 'string' },
    }

    expect(wrapTemplateWithEvidence(template)).toEqual({
      cemetery: {
        _description: 'Only the excavation cemetery, not modern place names.',
        city: { value: 'string', snippet: 'string', page: 'number' },
      },
    })
  })

  it('drops "_strategy" entirely instead of passing it through like "_description"', () => {
    const template = {
      _strategy: 'catalog',
      entries: [{ name: 'verbatim-string' }],
    }

    expect(wrapTemplateWithEvidence(template)).toEqual({
      entries: [{ name: { value: 'verbatim-string', snippet: 'string', page: 'number' } }],
    })
  })

  it('leaves the leaf shape unchanged when hasTables is false or omitted', () => {
    const template = { grave: { depth: 'number' } }

    expect(wrapTemplateWithEvidence(template)).toEqual(wrapTemplateWithEvidence(template, false))
    expect(wrapTemplateWithEvidence(template, false)).toEqual({
      grave: { depth: { value: 'number', snippet: 'string', page: 'number' } },
    })
  })

  it('adds row_header/column_header slots to every leaf when hasTables is true', () => {
    const template = {
      grave: [{ name: 'verbatim-string', depth: 'number' }],
      cemetery: { city: 'string' },
    }

    expect(wrapTemplateWithEvidence(template, true)).toEqual({
      grave: [
        {
          name: { value: 'verbatim-string', snippet: 'string', page: 'number', row_header: 'string', column_header: 'string' },
          depth: { value: 'number', snippet: 'string', page: 'number', row_header: 'string', column_header: 'string' },
        },
      ],
      cemetery: {
        city: { value: 'string', snippet: 'string', page: 'number', row_header: 'string', column_header: 'string' },
      },
    })
  })
})

describe('splitEvidenceResult', () => {
  it('attaches parser-derived scope to nested evidence without changing result values', () => {
    const split = splitEvidenceResult({ grave: [{ name: { value: 'Grave 1', snippet: 'Grave 1', page: 2 } }] })

    expect(attachEvidenceSourceScope(split.evidence, {
      segment_id: 'catalog:3',
      markdown_start: 10,
      markdown_end: 30,
      start_page: 2,
      end_page: 2,
    })).toEqual({
      grave: [{ name: { value: 'Grave 1', snippet: 'Grave 1', page: 2, row_header: null, column_header: null, source_scope: { segment_id: 'catalog:3', markdown_start: 10, markdown_end: 30, start_page: 2, end_page: 2 } } }],
    })
    expect(split.result).toEqual({ grave: [{ name: 'Grave 1' }] })
  })

  it('returns a clean extraction result and mirrored evidence leaves', () => {
    const extracted = {
      grave: [
        {
          name: { value: 'Grave 1', snippet: 'Grave 1', page: 2 },
          depth: { value: 42, snippet: '', page: 2 },
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

  it('keeps domain objects with value snippet and page fields intact', () => {
    const extracted = {
      measurement: {
        value: { value: '42 cm', snippet: null, page: null },
        snippet: { value: 'recorded in trench notes', snippet: null, page: null },
        page: { value: 12, snippet: null, page: null },
      },
    }

    expect(splitEvidenceResult(extracted)).toEqual({
      result: {
        measurement: {
          value: '42 cm',
          snippet: 'recorded in trench notes',
          page: 12,
        },
      },
      evidence: null,
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
      evidence: { cemetery: { city: { value: 'Ribe', snippet: 'Ribe', page: 3, row_header: null, column_header: null } } },
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

  it('carries row_header/column_header through when the model provides them', () => {
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
