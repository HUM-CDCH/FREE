/**
 * The record scope rules Studio enforces (contract: `apps/parsing_service/tests/fixtures/contracts/record-scope.json`):
 * admission runs a Schema Revision only under the strategy its declared scope names, and acceptance holds a
 * document-scope result to exactly one root record. The Parsing Service checks the same again when it runs.
 */

import { ExtractionError } from './errors.js'
import { recordScopeOf, strategyOf, type RecordScope } from './schema.js'
import type { ExtractionStrategy } from './types.js'

const STRATEGY_LABEL: Record<ExtractionStrategy, string> = { ARTICLE: 'Article', CATALOG: 'Catalog' }

/**
 * Refuses an Extraction Strategy the pinned Schema Revision's record scope does not name, before anything is started:
 * `record_scope_required` when the revision declares none (a legacy definition whose task selection was ambiguous),
 * `record_scope_mismatch` when it declares the other scope. `subject` names the revision (or batch) in the message.
 */
export function refuseRecordScope(
  recordScope: RecordScope | null,
  strategy: ExtractionStrategy,
  subject = 'The selected Schema Revision',
): void {
  if (recordScope === null)
    throw new ExtractionError(
      'record_scope_required',
      `${subject} does not declare whether it extracts one Article or a Catalog of records. Choose Article or Catalog for the schema and save it before extracting.`,
    )
  if (recordScope !== recordScopeOf(strategy))
    throw new ExtractionError(
      'record_scope_mismatch',
      `${subject} is saved as ${STRATEGY_LABEL[strategyOf(recordScope)]} (${recordScope} scope); it cannot run as ${STRATEGY_LABEL[strategy]}.`,
    )
}

/** The record scope a stored `SchemaRevision.recordScope` declares; null declares none. Any other value is refused. */
export function storedRecordScope(value: unknown): RecordScope | null {
  if (value === null || value === undefined) return null
  if (value === 'document' || value === 'records') return value
  throw new ExtractionError('invalid_schema_revision', 'The selected Schema Revision declares an unknown record scope.')
}

/** Refuses a result whose number of root records its record scope does not allow: a document is exactly one. */
export function refuseRecordCardinality(recordScope: RecordScope, records: number): void {
  if (recordScope === 'document' && records !== 1)
    throw new ExtractionError(
      'invalid_model_output',
      `The document record scope requires exactly one root record; kei-exp returned ${records}.`,
    )
}
