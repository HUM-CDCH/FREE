import { ExtractionError } from './errors.js'
import type {
  CatalogDiagnostics,
  ExtractionRetrySelection,
  ExtractionAttemptSnapshot,
  ExtractionSnapshot,
  RetryExtractionInput,
} from './types.js'

/** Bound retained for validating stored Catalog retry selections. */
export const CATALOG_RECORD_LIMIT = 500

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

export function sameRetrySelection(
  stored:
    | Readonly<{
        retryDocument: boolean
        rediscover: boolean
        retryRecordStartBlockIds: readonly string[]
      }>
    | null
    | undefined,
  input: Readonly<{
    retryDocument: boolean
    rediscover: boolean
    retryRecordStartBlockIds: readonly string[]
  }>,
): boolean {
  return (
    stored != null &&
    stored.retryDocument === input.retryDocument &&
    stored.rediscover === input.rediscover &&
    sameIdSet(
      stored.retryRecordStartBlockIds,
      input.retryRecordStartBlockIds,
    )
  )
}

export type CatalogRetryContext = Readonly<{
  parent: ExtractionAttemptSnapshot | ExtractionSnapshot
  parentCatalog: CatalogDiagnostics
  selection: ExtractionRetrySelection
}>

/** Validate a targeted Catalog retry against its immediate parent before any model work. */
export function validateCatalogRetry(
  parent: ExtractionAttemptSnapshot | ExtractionSnapshot | null,
  input: RetryExtractionInput,
): CatalogRetryContext {
  if (!parent)
    throw new ExtractionError('not_found', 'The retry parent was not found.')
  if (
    'executionStatus' in parent &&
    parent.executionStatus !== 'COMPLETED' &&
    parent.executionStatus !== 'FAILED'
  )
    throw new ExtractionError('invalid_retry', 'The Catalog parent is still running.')
  if (parent.strategy !== 'CATALOG')
    throw new ExtractionError(
      'invalid_retry',
      'Targeted retry is available only for Catalog attempts.',
    )
  if (
    parent.outcome === 'CANCELLED' ||
    ('executionStatus' in parent && parent.failure?.code === 'cancelled')
  )
    throw new ExtractionError('invalid_retry', 'The Catalog parent is not retryable.')
  if (input.retryRecordStartBlockIds.length > CATALOG_RECORD_LIMIT)
    throw new ExtractionError(
      'invalid_retry',
      `A retry may select at most ${CATALOG_RECORD_LIMIT} records.`,
    )
  const parentCatalog = parent.diagnostics?.catalog ?? null
  if (!parentCatalog)
    throw new ExtractionError('invalid_retry', 'The Catalog parent has no valid diagnostics.')
  const discovery = parentCatalog.stages.find((stage) => stage.stage === 'discovery')
  const documentValues = parentCatalog.stages.find(
    (stage) => stage.stage === 'document-values',
  )
  if (!input.rediscover && discovery?.outcome !== 'succeeded')
    throw new ExtractionError(
      'invalid_retry',
      'A failed Catalog discovery requires rediscover=true.',
    )
  if (input.retryDocument && documentValues?.outcome !== 'failed')
    throw new ExtractionError(
      'invalid_retry',
      'retryDocument must target a failed document-values stage.',
    )
  if (
    !input.retryDocument &&
    documentValues?.outcome === 'succeeded' &&
    (typeof parentCatalog.documentValues !== 'object' ||
      parentCatalog.documentValues === null ||
      Array.isArray(parentCatalog.documentValues))
  )
    throw new ExtractionError(
      'invalid_retry',
      'The Catalog parent has no reusable document values.',
    )
  const recordById = new Map(
    parentCatalog.records.map((record) => [record.boundary.startBlockId, record]),
  )
  const selected = new Set(input.retryRecordStartBlockIds)
  if (selected.size !== input.retryRecordStartBlockIds.length)
    throw new ExtractionError('invalid_retry', 'Retry record identities must be unique.')
  for (const startBlockId of selected) {
    const record = recordById.get(startBlockId)
    if (!record || !['failed', 'not_attempted'].includes(record.outcome))
      throw new ExtractionError(
        'invalid_retry',
        'Retry records must identify failed canonical parent records.',
      )
  }
  if (
    !input.rediscover &&
    !input.retryDocument &&
    selected.size === 0 &&
    (!parent.result || (
      parent.outcome !== 'SUCCEEDED' &&
      (!('executionStatus' in parent) || parent.executionStatus !== 'FAILED')
    ))
  )
    throw new ExtractionError(
      'invalid_retry',
      'Grounding-only retry requires a succeeded parent result.',
    )
  return {
    parent,
    parentCatalog,
    selection: {
      retryOfId: input.retryOfId,
      retryDocument: input.retryDocument,
      rediscover: input.rediscover,
      retryRecordStartBlockIds: [...input.retryRecordStartBlockIds],
    },
  }
}
