export type ExtractionErrorCode =
  | 'not_found'
  | 'invalid_request'
  | 'invalid_extraction_pins'
  | 'extraction_id_conflict'
  | 'extraction_in_progress'
  | 'invalid_source_representation'
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
  | 'cancelled'

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
