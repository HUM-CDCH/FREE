import {
  parseBatchSuggestionDefinition,
  templateToSchemaDefinition,
  type SchemaDefinition,
} from 'extraction/schema'
import { ApiError } from './_http.js'

function invalidModelOutput(error: unknown): never {
  throw new ApiError(
    502,
    'invalid_model_output',
    error instanceof Error
      ? error.message
      : 'The model returned an invalid Schema Suggestion.',
  )
}

/** Reject, never strip, fields that are owned by canonical parser Evidence. */
export function modelSuggestedDefinition(template: unknown): SchemaDefinition {
  try {
    return parseBatchSuggestionDefinition(templateToSchemaDefinition(template))
  } catch (error) {
    return invalidModelOutput(error)
  }
}

export function sourceSuggestionFailure(error: unknown): {
  code:
    | 'invalid_model_config'
    | 'model_operation_failed'
    | 'invalid_model_output'
    | 'model_key_required'
    | 'merge_input_too_large'
    | 'unexpected_failure'
} {
  if (
    error instanceof ApiError &&
    (error.code === 'invalid_model_config' ||
      error.code === 'model_operation_failed' ||
      error.code === 'invalid_model_output' ||
      error.code === 'model_key_required' ||
      error.code === 'merge_input_too_large')
  )
    return { code: error.code }
  return { code: 'unexpected_failure' }
}

/** The researcher may edit names, but cannot create duplicate fields at one level. */
export function validateEditableSuggestion(
  definition: SchemaDefinition,
): SchemaDefinition {
  try {
    return parseBatchSuggestionDefinition(definition)
  } catch (error) {
    throw new ApiError(
      422,
      'invalid_request',
      error instanceof Error ? error.message : 'Common fields are invalid.',
    )
  }
}
