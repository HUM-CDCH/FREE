import { describe, expect, it } from 'vitest'
import { schemaPrompt } from './_schema'

describe('schemaPrompt', () => {
  it('defaults to article-style guidance when no strategy is given', () => {
    const prompt = schemaPrompt([{ text: 'Grave 1', pageNumber: 1 }], 'hints')

    expect(prompt).not.toContain('This document is a Catalog')
    expect(prompt).toContain('If the document repeats a structural unit')
  })

  it('tells the model to design one occurrence directly, without wrapping in an array, for the catalog strategy', () => {
    const prompt = schemaPrompt([{ text: 'Grave 1', pageNumber: 1 }], 'hints', 'catalog')

    expect(prompt).toContain('This document is a Catalog')
    expect(prompt).toContain('Do not wrap the schema in an array')
    // The article-oriented "generalize across occurrences" guidance must not
    // also appear — it would contradict the catalog instruction above.
    expect(prompt).not.toContain('If the document repeats a structural unit')
  })

  it('uses catalog guidance in "fields" mode too, not just "hints"', () => {
    const prompt = schemaPrompt([{ text: 'Grave 1', pageNumber: 1 }], 'fields', 'catalog')

    expect(prompt).toContain('This document is a Catalog')
    expect(prompt).not.toContain('design that field as an array so it can generalize')
  })

  it('keeps the pre-existing article-style array guidance for "fields" mode with annotations', () => {
    const prompt = schemaPrompt([{ text: 'Grave 1', pageNumber: 1 }], 'fields', 'article')

    expect(prompt).toContain('design that field as an array so it can generalize')
  })

  it('emits no generalization guidance for article strategy with no annotations', () => {
    const prompt = schemaPrompt([], 'hints', 'article')

    expect(prompt).not.toContain('This document is a Catalog')
    expect(prompt).not.toContain('If the document repeats a structural unit')
  })
})
