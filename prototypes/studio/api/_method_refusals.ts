import { ExtractionError } from 'extraction'
import { ApiError } from './_http.js'

/**
 * How a start answers admission's refusal of the method it submitted, single and batch alike: a stale start view is a
 * refreshable conflict, identity fields the pinned schema cannot key records by are the researcher's to change, and a
 * saved configuration admission cannot read is a server fault whose contents are never echoed. Null for any other
 * error, which the route maps itself.
 */
export function methodRefusal(error: unknown): ApiError | null {
  if (!(error instanceof ExtractionError)) return null
  switch (error.code) {
    case 'method_changed':
      return new ApiError(409, 'method_changed', error.message, { cause: error })
    case 'invalid_identity_fields':
      return new ApiError(422, 'invalid_identity_fields', error.message, { cause: error })
    case 'invalid_model_config':
      return new ApiError(500, 'invalid_model_config', 'The saved model configuration is invalid.', { cause: error })
    default:
      return null
  }
}
