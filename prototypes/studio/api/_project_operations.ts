import { randomUUID, createHash } from 'node:crypto'
import { canonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import {
  createProjectStore,
  type BatchExtractionRecord,
  type BatchSchemaSuggestionRecord,
  type OperationLease,
  type ProjectStore,
} from '../../../packages/db/src/project-store.js'
import { parseSchemaDefinition } from '../shared/schemaNode.js'
import {
  createExtractionExecutor,
  type ExtractionExecutor,
} from './extractions.js'
import {
  modelSuggestedDefinition,
  sourceSuggestionFailure,
  verifiedCommonSuggestion,
} from './_batch_schema_suggestions.js'
import { generateSchemaWithModel } from './_model.js'

const LEASE_MS = 2 * 60 * 1000
const LEASE_RENEW_MS = 30 * 1000
const MODEL_OPERATION_TIMEOUT_MS = 10 * 60 * 1000
const SOURCE_SUGGESTION_INSTRUCTION =
  'Suggest reusable extraction fields for this Source Document. Never include canonical Evidence fields: _evidence, snippets, pages, bboxes, occurrence IDs, or fuzzy matches.'

type OperationStore = Pick<
  ProjectStore,
  | 'claimBatchExtraction'
  | 'renewBatchExtractionLease'
  | 'startBatchExtractionMember'
  | 'completeBatchExtractionMember'
  | 'failBatchExtraction'
  | 'claimBatchSchemaSuggestion'
  | 'renewBatchSchemaSuggestionLease'
  | 'startBatchSchemaSuggestionSource'
  | 'completeBatchSchemaSuggestionSource'
  | 'startBatchSchemaSuggestionMerge'
  | 'completeBatchSchemaSuggestionMerge'
  | 'failBatchSchemaSuggestion'
>

export type ProjectOperations = { kick(): void }

export type ProjectOperationsDependencies = {
  store?: OperationStore
  readMarkdown?: typeof canonicalPackageStore.read
  generate?: typeof generateSchemaWithModel
  executeExtraction?: ExtractionExecutor
  now?: () => Date
}

function fingerprintId(value: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${(['8', '9', 'a', 'b'] as const)[parseInt(hash[16], 16) & 3]}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

function memberExtractionId(
  batch: BatchExtractionRecord,
  member: BatchExtractionRecord['members'][number],
): string {
  return fingerprintId([
    'batch-member-extraction',
    batch.batchExtractionId,
    member.sourceRepresentationRevisionId,
  ])
}

function durableFailure(error: unknown): { code: string; message: string } {
  const code = sourceSuggestionFailure(error).code
  const message =
    code === 'unexpected_failure'
      ? 'The operation failed unexpectedly.'
      : error instanceof Error
        ? error.message
        : 'The operation failed unexpectedly.'
  return { code, message: message.slice(0, 512) }
}

function leaseSignal(
  renew: (expiresAt: Date) => Promise<boolean>,
  now: () => Date,
) {
  const lost = new AbortController()
  let renewing = false
  const timer = setInterval(() => {
    if (renewing || lost.signal.aborted) return
    renewing = true
    void renew(new Date(now().getTime() + LEASE_MS))
      .then((owned) => {
        if (!owned) lost.abort()
      })
      .catch(() => lost.abort())
      .finally(() => {
        renewing = false
      })
  }, LEASE_RENEW_MS)
  return {
    signal: lost.signal,
    stop: () => clearInterval(timer),
    lost: () => lost.signal.aborted,
  }
}

function modelSignal(lease: AbortSignal): AbortSignal {
  return AbortSignal.any([lease, AbortSignal.timeout(MODEL_OPERATION_TIMEOUT_MS)])
}

/**
 * A small in-process dispatcher. The process-local pump only schedules work;
 * durable leases and checkpoint writes are the correctness boundary.
 */
export function createProjectOperations(
  dependencies: ProjectOperationsDependencies = {},
): ProjectOperations {
  const store = dependencies.store ?? createProjectStore()
  const readMarkdown = dependencies.readMarkdown ?? canonicalPackageStore.read
  const generate = dependencies.generate ?? generateSchemaWithModel
  const executeExtraction =
    dependencies.executeExtraction ?? createExtractionExecutor()
  const now = dependencies.now ?? (() => new Date())
  const owner = randomUUID()
  let pumping = false
  let requested = false

  async function runSuggestion(
    suggestion: BatchSchemaSuggestionRecord & { lease: OperationLease },
  ) {
    const guard = leaseSignal(
      (expiresAt) =>
        store.renewBatchSchemaSuggestionLease(
          suggestion.batchSchemaSuggestionId,
          suggestion.lease,
          expiresAt,
        ),
      now,
    )
    try {
      const definitions = new Map<string, ReturnType<typeof parseSchemaDefinition>>()
      let failed = false
      for (const source of suggestion.sources) {
        if (source.executionStatus === 'COMPLETED') {
          definitions.set(source.sourceDocumentId, parseSchemaDefinition(source.definition))
          continue
        }
        if (
          !(await store.startBatchSchemaSuggestionSource(
            suggestion.batchSchemaSuggestionId,
            source.sourceDocumentId,
            suggestion.lease,
            now(),
          ))
        )
          return
        try {
          const artifact = await readMarkdown(source.descriptor, 'markdown')
          guard.signal.throwIfAborted()
          const generated = await generate({
            document: {
              file: null,
              markdown: new TextDecoder().decode(artifact.bytes),
              pages: null,
            },
            instruction: SOURCE_SUGGESTION_INSTRUCTION,
            signal: modelSignal(guard.signal),
          })
          const definition = modelSuggestedDefinition(generated.template)
          definitions.set(source.sourceDocumentId, definition)
          if (
            !(await store.completeBatchSchemaSuggestionSource(
              suggestion.batchSchemaSuggestionId,
              source.sourceDocumentId,
              suggestion.lease,
              { definition },
              now(),
            ))
          )
            return
        } catch (error) {
          if (guard.signal.aborted) return
          failed = true
          if (
            !(await store.completeBatchSchemaSuggestionSource(
              suggestion.batchSchemaSuggestionId,
              source.sourceDocumentId,
              suggestion.lease,
              { failure: durableFailure(error) },
              now(),
            ))
          )
            return
        }
      }
      if (failed) {
        await store.failBatchSchemaSuggestion(
          suggestion.batchSchemaSuggestionId,
          suggestion.lease,
          {
            code: 'source_suggestion_failed',
            message:
              'Fields could not be suggested for every selected Source Document.',
          },
          now(),
        )
        return
      }
      if (
        !(await store.startBatchSchemaSuggestionMerge(
          suggestion.batchSchemaSuggestionId,
          suggestion.lease,
        ))
      )
        return
      const generated = await generate({
        document: {
          file: null,
          markdown: suggestion.sources
            .map((source) => {
              const definition = definitions.get(source.sourceDocumentId)
              if (!definition)
                throw new Error('Stored source suggestion is unavailable.')
              return `SOURCE DOCUMENT ${source.sourceDocumentId} SUGGESTION:\n${JSON.stringify(definition)}`
            })
            .join('\n\n'),
          pages: null,
        },
        instruction:
          'Return one compact Extraction Schema containing only fields present in every supplied Source Document suggestion. Do not include extracted values, alternatives, merge notes, or canonical Evidence fields (_evidence, snippets, pages, bboxes, occurrence IDs, fuzzy matches).',
        signal: modelSignal(guard.signal),
      })
      guard.signal.throwIfAborted()
      const common = verifiedCommonSuggestion(
        generated.template,
        suggestion.sources.map((source) => {
          const definition = definitions.get(source.sourceDocumentId)
          if (!definition) throw new Error('Stored source suggestion is unavailable.')
          return definition
        }),
      )
      await store.completeBatchSchemaSuggestionMerge(
        suggestion.batchSchemaSuggestionId,
        suggestion.lease,
        common
          ? {
              proposal: common.definition,
              coverage: common.coverage,
              draft: common.definition,
            }
          : { heterogeneous: true },
        now(),
      )
    } catch (error) {
      if (!guard.lost() && !guard.signal.aborted)
        await store.failBatchSchemaSuggestion(
          suggestion.batchSchemaSuggestionId,
          suggestion.lease,
          durableFailure(error),
          now(),
        )
    } finally {
      guard.stop()
    }
  }

  async function runBatch(
    batch: BatchExtractionRecord & { lease: OperationLease },
  ) {
    const guard = leaseSignal(
      (expiresAt) =>
        store.renewBatchExtractionLease(
          batch.batchExtractionId,
          batch.lease,
          expiresAt,
        ),
      now,
    )
    try {
      for (const member of batch.members) {
        if (member.executionStatus === 'COMPLETED') continue
        if (
          !(await store.startBatchExtractionMember(
            batch.batchExtractionId,
            member.sourceDocumentId,
            batch.lease,
            now(),
          ))
        )
          return
        try {
          await executeExtraction(
            {
              id: memberExtractionId(batch, member),
              sourceRepresentationRevisionId:
                member.sourceRepresentationRevisionId,
              schemaRevisionId: batch.schemaRevisionId,
              strategy: batch.strategy,
              batchExtractionId: batch.batchExtractionId,
            },
            modelSignal(guard.signal),
          )
          if (
            !(await store.completeBatchExtractionMember(
              batch.batchExtractionId,
              member.sourceDocumentId,
              batch.lease,
              { completed: true },
              now(),
            ))
          )
            return
        } catch (error) {
          if (guard.signal.aborted) return
          if (
            !(await store.completeBatchExtractionMember(
              batch.batchExtractionId,
              member.sourceDocumentId,
              batch.lease,
              { failure: durableFailure(error) },
              now(),
            ))
          )
            return
        }
      }
    } catch (error) {
      if (!guard.lost() && !guard.signal.aborted)
        await store.failBatchExtraction(
          batch.batchExtractionId,
          batch.lease,
          durableFailure(error),
          now(),
        )
    } finally {
      guard.stop()
    }
  }

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (requested) {
        requested = false
        for (;;) {
          const startedAt = now()
          const expiresAt = new Date(startedAt.getTime() + LEASE_MS)
          const suggestion = await store.claimBatchSchemaSuggestion(
            owner,
            startedAt,
            expiresAt,
          )
          if (suggestion) {
            await runSuggestion(suggestion)
            continue
          }
          const batch = await store.claimBatchExtraction(
            owner,
            startedAt,
            expiresAt,
          )
          if (batch) {
            await runBatch(batch)
            continue
          }
          break
        }
      }
    } finally {
      pumping = false
      if (requested) void pump()
    }
  }

  return {
    kick() {
      requested = true
      void pump()
    },
  }
}

/** Shared production dispatcher; tests inject isolated dispatchers. */
export const projectOperations = createProjectOperations()
