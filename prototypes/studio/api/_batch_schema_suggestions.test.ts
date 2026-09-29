import { describe, expect, it } from 'vitest'
import { sourceSuggestionFailure } from './_batch_schema_suggestions.js'
import { suggestBatchSource } from './_schema_suggestion.js'
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

  it('recursively rejects canonical Evidence fields in every model response', async () => {
    await expect(suggestBatchSource(
      { researcherAccountId: 'researcher' }, 'source', new AbortController().signal,
      async () => ({
        template: {
          _description: 'One record.',
          place: { _description: 'One place.', fuzzyMatches: 'string' },
        },
        raw: '', pages: null,
      }),
    )).rejects.toThrow(/reserved Evidence/i)
  })
})
