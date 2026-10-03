export type ExtractionErrorCode =
  | 'not_found'
  | 'invalid_request'
  | 'invalid_extraction_pins'
  | 'extraction_id_conflict'
  | 'invalid_source_representation'
  | 'source_representation_superseded'
  | 'invalid_schema_revision'
  | 'invalid_model_output'
  | 'model_unavailable'
  | 'extraction_failed'
  | 'grounding_failed'
  | 'not_reviewable'
  | 'invalid_review'
  | 'review_conflict'
  | 'batch_conflict'
  | 'batch_not_ready'
  | 'batch_failed'
  | 'catalog_discovery_failed'
  | 'catalog_no_records'
  | 'cancelled'
  | 'method_changed'
  | 'invalid_identity_fields'
  | 'incompatible_extraction_model'
  | 'invalid_model_config'
  | 'invalid_extraction_method'
  | 'catalog_migration_required'
  /** The pinned Schema Revision declares no record scope: a legacy definition needs Article or Catalog chosen. */
  | 'record_scope_required'
  /** The requested Extraction Strategy is not the one the pinned Schema Revision's record scope names. */
  | 'record_scope_mismatch'

export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode
  readonly cause?: unknown

  constructor(code: ExtractionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'ExtractionError'
    this.code = code
    this.cause = options?.cause
  }
}

export function extractionError(error: unknown, fallback: ExtractionErrorCode = 'extraction_failed'): ExtractionError {
  if (error instanceof ExtractionError) return error
  if (error instanceof DOMException && error.name === 'AbortError')
    return new ExtractionError('cancelled', 'The Extraction was cancelled.', { cause: error })
  return new ExtractionError(
    fallback,
    error instanceof Error ? error.message : 'The Extraction failed.',
    { cause: error },
  )
}
