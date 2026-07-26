import { describe, expect, it } from 'vitest'
import { splitEvidenceResult, wrapTemplateWithEvidence } from './_evidence_template'

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
})

describe('splitEvidenceResult', () => {
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
      evidence: { grave: [{ name: { value: 'Grave 1', snippet: 'Grave 1', page: 2 } }] },
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
      evidence: { cemetery: { city: { value: 'Ribe', snippet: 'Ribe', page: 3 } } },
    })
  })
})
