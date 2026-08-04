import { describe, expect, it } from 'vitest'
import { nodesToTemplate, templateToNodes } from './schemaNode'

describe('allowed values in the Extraction Schema template', () => {
  it('reads a literal array of two or more values as a closed set', () => {
    expect(templateToNodes({ koen: ['mand', 'kvinde', 'ukendt'] })).toEqual([
      { id: expect.any(String), name: 'koen', type: 'string', allowedValues: ['mand', 'kvinde', 'ukendt'] },
    ])
  })

  it('keeps type tokens and single literals as ordinary fields', () => {
    // Measured against NuExtract: only two or more non-token literals bind as a
    // closed set; ["string"] means array-of-string and ["mand"] stays an array.
    expect(templateToNodes({ film: ['string'], tags: ['mand'] })).toEqual([
      { id: expect.any(String), name: 'film', type: 'string' },
      { id: expect.any(String), name: 'tags', type: 'mand' },
    ])
  })

  it('round-trips a closed set through the panel and back to the template', () => {
    const template = {
      koen: ['mand', 'kvinde', 'ukendt'],
      grave: [{ material: ['jern', 'bronze'], depth: 'number' }],
      site: { region: ['sjælland', 'jylland'] },
    }

    expect(nodesToTemplate(templateToNodes(template))).toEqual(template)
  })

  it('leaves an ordinary schema untouched', () => {
    const template = { grave: [{ name: 'verbatim-string' }], cemetery: { city: 'string' } }

    expect(nodesToTemplate(templateToNodes(template))).toEqual(template)
  })
})
