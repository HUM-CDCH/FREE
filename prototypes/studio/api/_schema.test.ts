import { describe, expect, it } from 'vitest'
import { schemaPrompt } from './_schema.js'

describe('schemaPrompt', () => {
  it('requires an explicit root record description', () => {
    const prompt = schemaPrompt('')

    expect(prompt).toContain('"_description"')
    expect(prompt).toContain('defining what constitutes ONE root record')
    expect(prompt).toContain('field names alone are not a record definition')
  })

  it('carries no examples from the development corpus, whatever the researcher\'s domain', () => {
    const prompt = schemaPrompt('')

    for (const corpusTerm of [/Grav/i, /\bmand\b/, /kvinde/, /ukendt/, /\bfinds?\b/i, /\bsex\b/])
      expect(prompt).not.toMatch(corpusTerm)
  })

  it('keeps the structural instructions for templates, repeating values and closed value sets', () => {
    const prompt = schemaPrompt('')

    expect(prompt).toContain('distinguish record boundaries')
    expect(prompt).toContain('"references": ["verbatim-string"]')
    expect(prompt).toContain('Place the actual requested field names directly inside "template"')
    expect(prompt).toContain('Never return a "fields" list')
    expect(prompt).toContain('give that field a literal array of the allowed values instead of a type label')
    expect(prompt).toContain('Use the researcher\'s requested fields and record scope when supplied.')
  })

  it('puts the researcher\'s instruction first', () => {
    expect(schemaPrompt('  Each record is one court case.  ')).toMatch(
      /^Additional instruction from the researcher:\nEach record is one court case\.\n\n/,
    )
  })
})
