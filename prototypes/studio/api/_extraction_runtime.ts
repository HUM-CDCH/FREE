import { createExtractionRuntime, createKeiExpClient, type ExtractionAttemptSnapshot, type ExtractionModule } from 'extraction'
import { extractionAttemptSchema } from '../shared/extraction.contract.js'

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
            return typeof code === 'string'
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
    ...(diagnostics.grounded ? { grounded: diagnostics.grounded } : {}),
    ...(diagnostics.models ? { models: diagnostics.models } : {}),
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
    requestedModels: extraction.requestedModels ?? null,
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


/** The one kei-exp client: jobs extract through it, and Studio lists the deployment's extraction models with it.
 *  It names no model itself: a run sends the configured Extraction Model Choice (kei-exp model keys per role) or
 *  none, and kei-exp's deployment defaults fill the rest. Model Connections and Capability Routes never reach
 *  kei-exp; the models that actually ran are read back from the artifact. */
export const keiExpClient = createKeiExpClient({
  url: process.env.KEI_EXP_URL ?? (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_KEI_EXP_URL ?? 'http://127.0.0.1:8001',
})

export const extractionRuntime = createExtractionRuntime({ keiExp: keiExpClient })
export function createResearcherExtractions(researcherAccountId: string): ExtractionModule {
  return extractionRuntime.forResearcher(researcherAccountId)
}
