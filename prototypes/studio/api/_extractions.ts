import { canonicalPackageStore, LIVE_WORKFLOW_STATUSES, workflowStatusesOf } from 'db'
import {
  contestedValues,
  createExtractions,
  createExtractionStore,
  createKeiExpClient,
  dbosSteps,
  type ExtractionAttemptSnapshot,
  type ExtractionExecution,
  type ExtractionModule,
  type ExtractionWorkflowPorts,
} from 'extraction'
import { createKeiHandoff, extractWorkflowId, keiExtractWorkflowId } from 'extraction/kei-handoff'
import { studioDbos } from '../server/dbos.js'
import { extractionAttemptSchema } from '../shared/extraction.contract.js'

/** kei's API: its read routes serve converted runs, published extraction artifacts and the model listings. */
export const KEI_EXP_URL = process.env.KEI_EXP_URL ?? 'http://127.0.0.1:8001'

/** The one kei-exp read client: runExtraction reads published artifacts through it, and Studio lists the deployment's
 *  extraction and ingestion models with it. It names no model: a run's Extraction Model Choice travels in its kei
 *  workflow input, and the models that actually ran are read back from the artifact. */
export const keiExpClient = createKeiExpClient({ url: KEI_EXP_URL })

/**
 * Admission, status reads and cancel through Studio's launched DBOS. Every call resolves the launch when it runs: a
 * module the dispatcher imports before launch, or a handler built for a request that never admits, holds nothing.
 */
export function extractionExecution(): ExtractionExecution {
  return {
    async enqueue(client, workflow, input) {
      // A workflow ID in use names an Extraction that is gone: the admission refuses it (ExtractionExecution).
      await studioDbos().admission.enqueueInTransaction(
        client,
        { ...workflow, attributes: { ...workflow.attributes }, workflowIDReusePolicy: 'reject' },
        input,
      )
    },
    statuses: (workflowIds) =>
      workflowStatusesOf((input) => studioDbos().admission.listWorkflows(input))(workflowIds),
    async cancel(extractionId) {
      const { admission, kei } = studioDbos()
      const studioId = extractWorkflowId(extractionId)
      const [studio] = await admission.listWorkflows({ workflowIDs: [studioId], loadInput: false, loadOutput: false })
      // A repeated cancel of a cancelled workflow would move its updated_at (M0R 4): live workflows only.
      if (studio && LIVE_WORKFLOW_STATUSES.has(studio.status)) await admission.cancelWorkflow(studioId)
      await createKeiHandoff(kei).cancel(keiExtractWorkflowId(extractionId))
    },
  }
}

/** What runExtraction runs on: DBOS steps, the Extraction store, the kei handoff and kei's artifact route. */
export function extractionWorkflowPorts(): ExtractionWorkflowPorts {
  return {
    steps: dbosSteps,
    store: createExtractionStore({ packages: canonicalPackageStore }),
    kei: createKeiHandoff(studioDbos().kei),
    readArtifact: (runId, extractionId, signal) => keiExpClient.readExtractionArtifact(runId, extractionId, signal),
  }
}

export function createResearcherExtractions(researcherAccountId: string): ExtractionModule {
  return createExtractions(researcherAccountId, extractionExecution())
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
  const contested = contestedValues(diagnostics, extraction.result)
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
    ...(diagnostics.grounded ? { grounded: diagnostics.grounded } : {}),
    ...(diagnostics.unified ? { unified: diagnostics.unified } : {}),
    ...(diagnostics.models ? { models: diagnostics.models } : {}),
    ...(diagnostics.effectiveMethod ? { effectiveMethod: diagnostics.effectiveMethod } : {}),
    ...(diagnostics.eligibility ? { eligibility: diagnostics.eligibility } : {}),
    ...(diagnostics.support ? { support: diagnostics.support } : {}),
    ...(contested.length > 0 ? { contested } : {}),
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
    catalogRecipe: extraction.catalogRecipe,
    requestedModels: extraction.requestedModels ?? null,
    requestedSettings: extraction.requestedSettings ?? null,
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
    batchExtractionId: extraction.batchExtractionId,
    createdAt: extraction.createdAt.toISOString(),
    reviewedAt: extraction.reviewedAt?.toISOString() ?? null,
    reviewDecisions: extraction.reviewDecisions.map((decision) => ({
      ...decision,
      createdAt: decision.createdAt.toISOString(),
    })),
  })
}
