import { describe, expect, it } from 'vitest'
import type { SchemaDefinition } from 'extraction/schema'
import { sourceSuggestionFailure } from './_batch_schema_suggestions.js'
import { suggestBatchCommon, suggestBatchSource } from './_schema_suggestion.js'
import { ApiError } from './_http.js'
import { ModelKeyRequiredError } from './_model_keys.js'

describe('batch source Schema Suggestions', () => {
  it('reduces source failures to safe diagnostic codes', () => {
    expect(
      sourceSuggestionFailure(
        new ApiError(502, 'invalid_model_output', 'provider secret'),
      ),
    ).toEqual({ code: 'invalid_model_output' })
    expect(sourceSuggestionFailure(new Error('provider secret'))).toEqual({
      code: 'unexpected_failure',
    })
  })

  it('a missing key is recorded as model_key_required', () => {
    expect(sourceSuggestionFailure(new ModelKeyRequiredError())).toEqual({
      code: 'model_key_required',
    })
  })

  it('accepts the same field names as ordinary Extraction Schema validation, at every depth', async () => {
    const suggested = await suggestBatchSource(
      { researcherAccountId: 'researcher' }, 'source', new AbortController().signal,
      async () => ({
        template: {
          _description: 'One record.',
          pages: 'string',
          place: { _description: 'One place.', fuzzyMatches: 'string', evidence: 'string' },
        },
        raw: '', pages: null, sourceCoverage: { complete: true },
      }),
    )
    expect(suggested.definition.schemaNodes.map((node) => node.name)).toEqual(['pages', 'place'])
    expect(suggested.definition.schemaNodes[1]!.children!.map((node) => node.name)).toEqual(['fuzzyMatches', 'evidence'])
  })

  it('describes system metadata by purpose without forbidding any field name in either instruction', async () => {
    const instructions: string[] = []
    const generate = async (_caller: unknown, options: { instruction: string }) => {
      instructions.push(options.instruction)
      return { template: { _description: 'One record.', title: 'string' }, raw: '', pages: null, sourceCoverage: { complete: true } as const }
    }
    const signal = new AbortController().signal
    const source = await suggestBatchSource({ researcherAccountId: 'researcher' }, 'source', signal, generate)
    await suggestBatchCommon({ researcherAccountId: 'researcher' },
      [{ sourceDocumentId: 'a', definition: source.definition }], signal, generate)

    expect(instructions).toHaveLength(2)
    for (const instruction of instructions) {
      expect(instruction).toContain('FREE records Evidence and its locations itself')
      expect(instruction).toContain("content of the researcher's records")
      for (const fieldName of [/_evidence/, /snippet/i, /\bpages?\b/i, /bbox/i, /occurrence/i, /fuzzy/i])
        expect(instruction).not.toMatch(fieldName)
    }
    expect(instructions[1]).toContain('only fields present in every supplied Source Document suggestion')
  })
})

describe('common-schema merge input', () => {
  const uuid = (n: number) => `51000000-0000-4000-8001-${String(n).padStart(12, '0')}`
  /** One Source Document suggestion of `fields` flat fields, about 55 characters of JSON each. */
  const suggestion = (n: number, fields = 15): { sourceDocumentId: string; definition: SchemaDefinition } => ({
    sourceDocumentId: uuid(n),
    definition: {
      recordDescription: `One record of source ${n}.`,
      schemaNodes: Array.from({ length: fields }, (_, i) => ({ id: `field-${n}-${i}`, name: `field_${i}`, type: 'string' as const })),
    },
  })
  const mergeCall = () => {
    const sent: string[] = []
    const generate = async (_caller: unknown, options: { document: { markdown: string | null } }) => {
      sent.push(options.document.markdown ?? '')
      return { template: { _description: 'One record.', field_0: 'string' }, raw: '', pages: null, sourceCoverage: { complete: true } as const }
    }
    return { sent, generate }
  }
  const signal = new AbortController().signal

  it('sends every suggestion whole when they fit, and declares none left out', async () => {
    const { sent, generate } = mergeCall()
    const sources = [1, 2, 3].map((n) => suggestion(n))

    const common = await suggestBatchCommon({ researcherAccountId: 'researcher' }, sources, signal, generate)

    expect(common.uncombined).toEqual([])
    expect(common.definition?.schemaNodes.map((node) => node.name)).toEqual(['field_0'])
    for (const source of sources) expect(sent[0]).toContain(JSON.stringify(source.definition))
  })

  it('past the budget, leaves out whole suggestions and names them, never cutting one mid-structure', async () => {
    const { sent, generate } = mergeCall()
    const sources = Array.from({ length: 50 }, (_, n) => suggestion(n + 1, 20))
    const serialized = sources.map((source) => `SOURCE DOCUMENT ${source.sourceDocumentId} SUGGESTION:\n${JSON.stringify(source.definition)}`)
    expect(serialized.join('\n\n').length).toBeGreaterThan(48_000)

    const common = await suggestBatchCommon({ researcherAccountId: 'researcher' }, sources, signal, generate)

    const [markdown] = sent
    expect(markdown!.length).toBeLessThanOrEqual(48_000)
    // What the merge read is exactly whole suggestion blocks; everything else is declared.
    const read = sources.filter((_, i) => markdown!.includes(serialized[i]!)).map((source) => source.sourceDocumentId)
    expect(markdown).toBe(serialized.filter((_, i) => read.includes(sources[i]!.sourceDocumentId)).join('\n\n'))
    expect(common.uncombined.length).toBeGreaterThan(0)
    expect(common.uncombined).toEqual(sources.map((source) => source.sourceDocumentId).filter((id) => !read.includes(id)))
  })

  it('refuses by name when not even one suggestion fits the merge', async () => {
    const { generate } = mergeCall()
    const failure = await suggestBatchCommon({ researcherAccountId: 'researcher' }, [suggestion(1, 1_000)], signal, generate)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ code: 'merge_input_too_large' })
    expect(sourceSuggestionFailure(failure)).toEqual({ code: 'merge_input_too_large' })
  })
})
