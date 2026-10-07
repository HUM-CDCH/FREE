import { ExtractionError } from 'extraction'
import { ApiError } from './_http.js'

/**
 * How a start answers admission's refusal, single, batch and suggested batch alike: a stale start view or a
 * strategy the schema's saved record scope does not name, is a refreshable conflict, identity fields the pinned schema
 * cannot key records by are the researcher's to change, and a saved configuration admission cannot read is a server
 * fault whose contents are never echoed. Null for any other error, which the route maps itself.
 */
export function methodRefusal(error: unknown): ApiError | null {
  if (!(error instanceof ExtractionError)) return null
  switch (error.code) {
    case 'method_changed':
      return new ApiError(409, 'method_changed', error.message, { cause: error })
    // Legacy Catalog preferences wait for the researcher's explicit migration: refreshable once it is applied.
    case 'catalog_migration_required':
      return new ApiError(409, 'catalog_migration_required', error.message, { cause: error })
    // The schema's saved Article/Catalog scope decides what runs: an undeclared legacy schema waits for the researcher's
    // choice, and a start under the other selection is a refreshable conflict with the saved definition.
    case 'record_scope_required':
      return new ApiError(409, 'record_scope_required', error.message, { cause: error })
    case 'record_scope_mismatch':
      return new ApiError(409, 'record_scope_mismatch', error.message, { cause: error })
    case 'invalid_identity_fields':
      return new ApiError(422, 'invalid_identity_fields', error.message, { cause: error })
    case 'invalid_schema_revision':
      return new ApiError(422, 'invalid_schema_revision', 'The selected Schema Revision is invalid.', { cause: error })
    case 'incompatible_extraction_model':
      return new ApiError(422, 'incompatible_extraction_model', error.message, { cause: error })
    case 'invalid_model_config':
      return new ApiError(500, 'invalid_model_config', 'The saved model configuration is invalid.', { cause: error })
    default:
      return null
  }
}
