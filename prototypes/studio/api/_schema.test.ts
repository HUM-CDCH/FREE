import { describe, expect, it } from 'vitest'
import { schemaPrompt } from './_schema.js'

describe('schemaPrompt', () => {
  it('requires an explicit root record description', () => {
    const prompt = schemaPrompt('')

    expect(prompt).toContain('"_description"')
    expect(prompt).toContain('defining what constitutes ONE root record')
    expect(prompt).toContain('field names alone are not a record definition')
  })
})
