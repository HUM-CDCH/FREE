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


export const extractionRuntime = createExtractionRuntime({
  keiExp: createKeiExpClient({
    url: process.env.KEI_EXP_URL ?? (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_KEI_EXP_URL ?? 'http://127.0.0.1:8001',
    // Not the extraction route's modelId: that names a model on a FREE Model Connection, while
    // kei-exp resolves this name against its own model server. Unset, kei-exp's deployment
    // default wins, and the model that actually ran is read back from the artifact.
    model: async () => process.env.KEI_EXP_EXTRACT_MODEL ?? null,
  }),
})
export function createResearcherExtractions(researcherAccountId: string): ExtractionModule {
  return extractionRuntime.forResearcher(researcherAccountId)
}
