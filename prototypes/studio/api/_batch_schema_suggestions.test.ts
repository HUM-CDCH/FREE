import { describe, expect, it } from 'vitest'
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
