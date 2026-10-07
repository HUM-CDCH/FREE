import { workflowStatusesOf } from 'db'
import {
  createExtractions,
  createKeiExpClient,
  type ExtractionAttemptSnapshot,
  type ExtractionExecution,
  type ExtractionModule,
} from 'extraction'
import { studioDbos } from '../server/dbos.js'
import { extractionAttemptSchema } from '../shared/extraction.contract.js'

/** kei's API: its read routes serve converted runs and the model listings. */
export const KEI_EXP_URL = process.env.KEI_EXP_URL ?? 'http://127.0.0.1:8001'

/** The one kei-exp read client: Studio lists the deployment's extraction and ingestion models with it. It names no
 *  model: a durable selection's Extraction Model Choice travels in its captured call inputs. */
export const keiExpClient = createKeiExpClient({ url: KEI_EXP_URL })

/**
 * Admission dispatch and Schema Suggestion status reads through Studio's launched DBOS. Every call resolves the launch
 * when it runs: a module the dispatcher imports before launch, or a handler built for a request that never admits,
 * holds nothing.
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
  }
}

export function createResearcherExtractions(researcherAccountId: string): ExtractionModule {
  return createExtractions(researcherAccountId, extractionExecution())
}

export function extractionAttemptDto(extraction: ExtractionAttemptSnapshot) {
  return extractionAttemptSchema.parse({
    extractionId: extraction.extractionId,
    sourceDocumentId: extraction.sourceDocumentId,
    sourceRepresentationRevisionId: extraction.sourceRepresentationRevisionId,
    schemaRevisionId: extraction.schemaRevisionId,
    strategy: extraction.strategy,
    catalogRecipe: extraction.catalogRecipe,
    requestedModels: extraction.requestedModels ?? null,
    requestedSettings: extraction.requestedSettings ?? null,
    executionStatus: extraction.executionStatus,
    finalizedReview: extraction.finalizedReview
      ? {
          snapshotVersion: extraction.finalizedReview.snapshotVersion,
          feedbackVersion: extraction.finalizedReview.feedbackVersion,
          createdAt: extraction.finalizedReview.createdAt.toISOString(),
        }
      : null,
    batchExtractionId: extraction.batchExtractionId,
    createdAt: extraction.createdAt.toISOString(),
  })
}
