import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { extractArticle } from './_article.js'
import type { ExtractionSchemaEnvelope } from './_catalog.js'

function fixture<T>(name: string): T {
  const text = readFileSync(new URL(`./test-fixtures/${name}`, import.meta.url), 'utf8')
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new Error(`Invalid JSON test fixture: ${name}`, { cause: error })
  }
}

describe('extractArticle', () => {
  it('uses one whole-document call and conforms collagen without inferring Catalog from entries', async () => {
    const schema = fixture<ExtractionSchemaEnvelope>('collagen_extraction.json')
    const generated = fixture<Record<string, unknown>>('article-result.json')
    const generate = vi.fn().mockResolvedValue(generated)

    const extraction = await extractArticle({
      document: '# Collagen study',
      schema,
      generate,
    })

    expect(generate).toHaveBeenCalledOnce()
    expect(generate.mock.calls[0]?.[0].document).toBe('# Collagen study')
    expect(extraction.warnings).toEqual([])
    expect(extraction.result.paper_title).toBe('Collagen study')
    expect((extraction.result.entries as Array<Record<string, unknown>>)[0]).toEqual(
      expect.objectContaining({
        scientific_name: 'Gadus morhua',
        tissue: 'Skin',
      }),
    )
  })
})
