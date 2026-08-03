import { describe, expect, it } from 'vitest'
import { applyAllowedValues, coerceAllowedValue, isAllowedValues } from './allowedValues'

const SEX = ['mand', 'kvinde', 'ukendt']

describe('isAllowedValues', () => {
  it('reads two or more literals as a closed set', () => {
    expect(isAllowedValues(SEX)).toBe(true)
  })

  it('leaves a single-element array as a scalar array', () => {
    // Measured: NuExtract answers ["mand"] with ["mand"], not "mand".
    expect(isAllowedValues(['mand'])).toBe(false)
    expect(isAllowedValues(['string'])).toBe(false)
  })

  it('is not tripped by objects, empty arrays, or non-strings', () => {
    expect(isAllowedValues([{ id: 'string' }, { id: 'string' }])).toBe(false)
    expect(isAllowedValues([])).toBe(false)
    expect(isAllowedValues('string')).toBe(false)
    expect(isAllowedValues([1, 2])).toBe(false)
  })

  it('rejects a list of type tokens, which means an array not a closed set', () => {
    expect(isAllowedValues(['string', 'number'])).toBe(false)
    expect(isAllowedValues(['verbatim-string', 'date', 'boolean'])).toBe(false)
  })
})

describe('coerceAllowedValue', () => {
  it('keeps a member unchanged', () => {
    expect(coerceAllowedValue('kvinde', SEX)).toBe('kvinde')
  })

  it('unwraps the one-item array the model sometimes returns', () => {
    expect(coerceAllowedValue(['mand'], SEX)).toBe('mand')
  })

  it('snaps a case or whitespace variant to its canonical member', () => {
    expect(coerceAllowedValue(' Mand ', SEX)).toBe('mand')
    expect(coerceAllowedValue(['UKENDT'], SEX)).toBe('ukendt')
  })

  it('keeps an out-of-list value verbatim rather than blanking the field', () => {
    expect(coerceAllowedValue('Jordfæstegrav', SEX)).toBe('Jordfæstegrav')
  })

  it('passes non-strings and multi-element answers through untouched', () => {
    expect(coerceAllowedValue(null, SEX)).toBeNull()
    expect(coerceAllowedValue(['mand', 'kvinde'], SEX)).toEqual(['mand', 'kvinde'])
  })
})

describe('applyAllowedValues', () => {
  const template = {
    records: [
      {
        grave_id: 'verbatim-string',
        koen: SEX,
        film: ['verbatim-string'],
        finds: [{ material: ['jern', 'bronze'] }],
      },
    ],
  }

  it('coerces closed-set fields at every depth and leaves everything else alone', () => {
    const result = {
      records: [
        { grave_id: '8', koen: [' Kvinde'], film: ['22-23', '24'], finds: [{ material: 'JERN' }] },
        { grave_id: '9', koen: 'mand', film: [], finds: [{ material: 'ukendt materiale' }] },
      ],
    }

    expect(applyAllowedValues(result, template)).toEqual({
      records: [
        { grave_id: '8', koen: 'kvinde', film: ['22-23', '24'], finds: [{ material: 'jern' }] },
        { grave_id: '9', koen: 'mand', film: [], finds: [{ material: 'ukendt materiale' }] },
      ],
    })
  })

  it('leaves the evidence sibling untouched', () => {
    const wrapped = {
      koen: SEX,
      _evidence: { koen: { snippet: 'string', page: 'number' } },
    }
    const extracted = {
      koen: ['Mand'],
      _evidence: { koen: { snippet: 'Grav 8, mand', page: 2 } },
    }

    expect(applyAllowedValues(extracted, wrapped)).toEqual({
      koen: 'mand',
      _evidence: { koen: { snippet: 'Grav 8, mand', page: 2 } },
    })
  })

  it('survives a result whose shape does not match the schema', () => {
    expect(applyAllowedValues({ koen: { unexpected: true } }, { koen: SEX })).toEqual({
      koen: { unexpected: true },
    })
  })
})
