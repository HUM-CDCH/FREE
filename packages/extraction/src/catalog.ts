import { ExtractionError } from './errors.js'
import type {
  CatalogDiagnostics,
  CatalogRecordDiagnostics,
  CatalogStage,
  CatalogStageDiagnostics,
  ExtractionRetrySelection,
  ExtractionAttemptSnapshot,
  ExtractionSnapshot,
  RetryExtractionInput,
} from './types.js'

/** Hard bound on attempted Catalog records per run; not a user setting. */
export const CATALOG_RECORD_LIMIT = 500

/** Durable failure code for Catalog records skipped by the record limit. */
export const CATALOG_NOT_ATTEMPTED_LIMIT = 'not_attempted_limit'

/** Call structure of a Catalog run. Links stay reviewer suggestions under
 *  every setting: no threshold, no score, no auto-accept. */
export type CatalogPolicy = Readonly<{
  /** Records per values call. A batch carries routing identities and falls
   *  back to one call per record when the response does not return them. */
  recordBatchSize: number
  /** Link a claim without the model when its value is a bounded token of
   *  exactly one candidate anchor in its record slice. */
  lexicalLinks: boolean
  /** Records whose unresolved claims share one grounding call. */
  groundingGroupSize: number
  /** Send each claim's record, field name and description to the grounder. */
  fieldAwareGrounding: boolean
}>

/** Five records per values call and per grounding call, each claim named
 *  by record and field: on the Beier excerpt 15 calls instead of 61 with
 *  identical values and links (docs/research/catalog-policy-v1.md).
 *  Lexical auto-linking stays off: it linked the wrong passage on traps. */
export const DEFAULT_CATALOG_POLICY: CatalogPolicy = {
  recordBatchSize: 5,
  lexicalLinks: false,
  groundingGroupSize: 5,
  fieldAwareGrounding: true,
}

/** The behaviour before policy v1: one values-only call per record. */
export const PER_RECORD_CATALOG_POLICY: CatalogPolicy = {
  recordBatchSize: 1,
  lexicalLinks: false,
  groundingGroupSize: 1,
  fieldAwareGrounding: false,
}

const CATALOG_POLICY_MAX_GROUP = 50

/** Parse a partial policy (for example the FREE_CATALOG_POLICY JSON); every
 *  missing key takes its default and an invalid value throws. */
export function parseCatalogPolicy(value: unknown): CatalogPolicy {
  const raw = value === null || value === undefined ? {} : value
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('A Catalog policy must be an object.')
  const policy = { ...DEFAULT_CATALOG_POLICY, ...(raw as Record<string, unknown>) }
  for (const key of ['recordBatchSize', 'groundingGroupSize'] as const) {
    const size = policy[key]
    if (!Number.isInteger(size) || (size as number) < 1 || (size as number) > CATALOG_POLICY_MAX_GROUP)
      throw new Error(`Catalog policy ${key} must be an integer from 1 to ${CATALOG_POLICY_MAX_GROUP}.`)
  }
  for (const key of ['lexicalLinks', 'fieldAwareGrounding'] as const)
    if (typeof policy[key] !== 'boolean') throw new Error(`Catalog policy ${key} must be a boolean.`)
  for (const key of Object.keys(policy))
    if (!(key in DEFAULT_CATALOG_POLICY)) throw new Error(`Unknown Catalog policy key: ${key}`)
  return policy as CatalogPolicy
}

export const CATALOG_STAGES = [
  'document-values',
  'discovery',
  'record-values',
  'grounding',
] as const

export type MutableCatalogDiagnostics = {
  stages: CatalogStageDiagnostics[]
  records: CatalogRecordDiagnostics[]
  documentValues: Record<string, unknown> | null
}

export function seedCatalogDiagnostics(): MutableCatalogDiagnostics {
  return {
    stages: CATALOG_STAGES.map((stage) => ({
      stage,
      provenance: 'executed',
      outcome: 'not_attempted',
      finishReason: null,
      calls: 0,
      inputTokens: null,
      outputTokens: null,
      durationMs: 0,
      failureCode: null,
    })),
    records: [],
    documentValues: null,
  }
}

export function setCatalogStage(
  catalog: MutableCatalogDiagnostics,
  stage: CatalogStage,
  diagnostics: Omit<CatalogStageDiagnostics, 'stage'>,
): void {
  const index = catalog.stages.findIndex((item) => item.stage === stage)
  catalog.stages[index] = { stage, ...diagnostics }
}

export function reuseCall<
  T extends CatalogStageDiagnostics | CatalogRecordDiagnostics,
>(value: T): T {
  return {
    ...value,
    provenance: 'reused',
    calls: 0,
    inputTokens: null,
    outputTokens: null,
    durationMs: 0,
  }
}
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
