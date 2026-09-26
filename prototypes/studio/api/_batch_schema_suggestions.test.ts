import { describe, expect, it } from 'vitest'
import {
  modelSuggestedDefinition,
  sourceSuggestionFailure,
} from './_batch_schema_suggestions.js'
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

  it('recursively rejects canonical Evidence fields in every model response', () => {
    expect(() =>
      modelSuggestedDefinition({
        _description: 'One record.',
        place: {
          _description: 'One place.',
          fuzzyMatches: 'string',
        },
      }),
    ).toThrow(/reserved Evidence/i)
  })
})
