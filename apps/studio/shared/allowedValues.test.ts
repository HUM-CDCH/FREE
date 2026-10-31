import { describe, expect, it } from 'vitest'
import { isAllowedValues } from 'extraction/allowed-values'

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
