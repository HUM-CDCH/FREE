import {
  createExtractionRuntime,
  ExtractionError,
  type ExtractionAttemptSnapshot,
  type ExtractionModel,
  type ExtractionModelSessions,
  type ExtractionModule,
  type GroundingModel,
  type ModelAttribution,
} from 'extraction'
import { extractionAttemptSchema } from '../shared/extraction.contract.js'
import { ApiError } from './_http.js'
import { groundingModelInput, groundingSelections } from './_grounding_prompt.js'
import { extractWithModel } from './_model.js'
import { readModelConfig } from './_model_config.js'
import { readCatalogPolicy } from './_catalog_policy.js'
import {
  resolveCapabilityRoute,
  type ExecutionTarget,
} from './_provider.js'

const GROUNDING_ISSUE_CODES: Readonly<Record<string, true>> = {
  missing_claim: true,
  unknown_claim_label: true,
  unknown_anchor_label: true,
  malformed_selection: true,
  grounding_failed: true,
}

function transportDiagnostics(
  extraction: ExtractionAttemptSnapshot,
) {
  const diagnostics = extraction.diagnostics
  if (!diagnostics) return null
  const phase = extraction.failure?.phase ?? diagnostics.phase
  const groundingReached =
    extraction.result !== null ||
    diagnostics.ungroundedPaths.length > 0 ||
    diagnostics.groundingIssues.length > 0 ||
    phase === 'grounding'
  return {
    phase,
    durationMs: diagnostics.durationMs,
    modelCalls: diagnostics.modelCalls,
    finishReason: diagnostics.finishReason,
    inputTokens: diagnostics.inputTokens,
    outputTokens: diagnostics.outputTokens,
    grounding: groundingReached
      ? {
          groundedPaths:
            extraction.evidence?.map((link) => link.resultPath) ?? [],
          ungroundedPaths: diagnostics.ungroundedPaths,
          issueCodes: diagnostics.groundingIssues.flatMap((issue) => {
            const code = issue.code
            return typeof code === 'string' && GROUNDING_ISSUE_CODES[code]
              ? [code]
              : []
          }),
          batches: diagnostics.groundingBatches,
        }
      : null,
    catalog: diagnostics.catalog
      ? {
          stages: diagnostics.catalog.stages,
          records: diagnostics.catalog.records,
        }
      : null,
    retry: diagnostics.retry ?? null,
  }
}

export function extractionAttemptDto(extraction: ExtractionAttemptSnapshot) {
  return extractionAttemptSchema.parse({
    extractionId: extraction.extractionId,
    sourceDocumentId: extraction.sourceDocumentId,
    sourceRepresentationRevisionId:
      extraction.sourceRepresentationRevisionId,
    schemaRevisionId: extraction.schemaRevisionId,
    strategy: extraction.strategy,
    executionStatus: extraction.executionStatus,
    outcome: extraction.outcome,
    complete: extraction.complete,
    modelAttribution: extraction.modelAttribution,
    diagnostics: transportDiagnostics(extraction),
    failure:
      extraction.failure
        ? {
            code: extraction.failure.code,
            message: extraction.failure.message.slice(0, 512),
          }
        : null,
    resultPayload: extraction.result,
    evidenceLinks: extraction.evidence,
    reviewable: extraction.reviewable,
    retryOfId: extraction.retryOfId,
    batchExtractionId: extraction.batchExtractionId,
    createdAt: extraction.createdAt.toISOString(),
    reviewedAt: extraction.reviewedAt?.toISOString() ?? null,
    reviewDecisions: extraction.reviewDecisions.map((decision) => ({
      ...decision,
      createdAt: decision.createdAt.toISOString(),
    })),
  })
}


function modelError(error: unknown): never {
  if (error instanceof DOMException && error.name === 'AbortError') throw error
  if (error instanceof ExtractionError) throw error
  throw new ExtractionError(
    error instanceof ApiError && error.code === 'invalid_model_output' ? 'invalid_model_output' : 'model_unavailable',
    error instanceof ApiError ? error.message : 'The Extraction model is unavailable.',
    { cause: error },
  )
}

async function extractionTarget(): Promise<
  ExecutionTarget & { attribution: ModelAttribution }
> {
  const target = await resolveCapabilityRoute(
    'extraction',
    {},
    { readConfig: readModelConfig },
  )
  if (!target.attribution)
    throw new ExtractionError(
      'model_unavailable',
      'The Extraction Route has no durable attribution.',
    )
  return target as ExecutionTarget & { attribution: ModelAttribution }
}

function modelFor(target: ExecutionTarget): ExtractionModel {
  return {
    async extract(request) {
    try {
      const generated = await extractWithModel(
        {
          document: {
            file: null,
            markdown: request.document.markdown,
            pages: request.document.pages,
          },
          template: request.template,
          outputSchema: request.outputSchema,
          instruction: request.instruction,
          signal: request.signal,
        },
        target,
      )
      return {
        result: generated.result,
        metadata: generated.metadata,
      }
    } catch (error) {
      modelError(error)
    }
    },
  }
}

function groundingModelFor(target: ExecutionTarget): GroundingModel {
  return {
    async ground(request) {
    try {
      const generated = await extractWithModel(groundingModelInput(request), target)
      return {
        selections: groundingSelections(generated.result),
        metadata: generated.metadata,
      }
    } catch (error) {
      if (error instanceof ExtractionError && error.code === 'grounding_failed')
        throw error
      modelError(error)
    }
    },
  }
}

const models: ExtractionModelSessions = {
  async open() {
    const target = await extractionTarget()
    return {
      attribution: target.attribution,
      model: modelFor(target),
      groundingModel: groundingModelFor(target),
    }
  },
}

export const extractionRuntime = createExtractionRuntime({
  models,
  readPolicy: readCatalogPolicy,
})
export function createResearcherExtractions(
  researcherAccountId: string,
): ExtractionModule {
  return extractionRuntime.forResearcher(researcherAccountId)
}
