import { randomUUID } from 'node:crypto'
import { canonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import {
  createInternalProjectWorkerStore,
  type BatchSchemaSuggestionRecord,
  type InternalProjectWorkerStore,
  type OperationLease,
} from 'db'
import { parseSchemaDefinition } from 'extraction/schema'
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


export type ProjectOperations = { kick(): void }

export type ProjectOperationsDependencies = {
  readMarkdown?: typeof canonicalPackageStore.read
  generate?: typeof generateSchemaWithModel
  now?: () => Date
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
  store: InternalProjectWorkerStore,
  dependencies: ProjectOperationsDependencies = {},
): ProjectOperations {
  const readMarkdown = dependencies.readMarkdown ?? canonicalPackageStore.read
  const generate = dependencies.generate ?? generateSchemaWithModel
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
      // Background work runs on the Project Context owner's configuration and keys, never on whoever kicked the pump.
      const owner = await store.projectContextOwner(suggestion.projectContextId)
      if (owner === null) return
      const caller = { researcherAccountId: owner }
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
          const generated = await generate(caller, {
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
      const generated = await generate(caller, {
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
export const projectOperations = createProjectOperations(
  createInternalProjectWorkerStore(),
)
