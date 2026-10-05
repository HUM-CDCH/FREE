import type { ResearcherProjectStore } from '../../../packages/db/src/project-store.js'

/** The read half of `ResearcherProjectStore`; the fixture answers no write. */
type ProjectStoreReads = Pick<
  ResearcherProjectStore,
  | 'listProjectContexts'
  | 'listRecentActivity'
  | 'getProjectContextWithDocuments'
  | 'getDocumentReopenSnapshot'
  | 'getSourceRepresentation'
>

export const DEMO_PROJECT_ID = '00000000-0000-4000-8000-000000000044'
export const DEMO_DOCUMENT_ID = '00000000-0000-4000-8000-000000000045'
export const DEMO_REPRESENTATION_ID = '00000000-0000-4000-8000-0000000000a1'
export const DEMO_ARTIFACT_REFERENCE = '00000000-0000-4000-8000-0000000000b1'

/** Deterministic read fixture for the contract tests and the E2E specs. */
export function projectContextFixture(): ProjectStoreReads {
  const project = {
    projectContextId: DEMO_PROJECT_ID,
    name: 'Ellekilde, TAK 1355',
    createdAt: new Date('2026-07-31T12:00:00.000Z'),
  }
  const sourceDocument = {
    sourceDocumentId: DEMO_DOCUMENT_ID,
    name: 'Beretning_Ellekilde_8_13.pdf',
    createdAt: new Date('2026-07-31T12:01:00.000Z'),
  }
  return {
    async listProjectContexts() {
      return [
        {
          ...project,
          sourceDocumentCount: 1,
          summary: {
            phase: 'chat' as const,
            extractionCount: 0,
            extractedSourceDocumentCount: 0,
            reviewedSourceDocumentCount: 0,
            staleSourceDocumentCount: 0,
            schemaDraftCount: 0,
            schemaStabilised: false,
            lastActivityAt: sourceDocument.createdAt,
            runningBatch: null,
          },
        },
      ]
    },
    async listRecentActivity(limit) {
      return [
        {
          kind: 'extraction_appended' as const,
          projectContextId: DEMO_PROJECT_ID,
          projectContextName: project.name,
          occurredAt: new Date('2026-07-31T12:03:00.000Z'),
        },
      ].slice(0, limit)
    },
    async getProjectContextWithDocuments(id) {
      return id === DEMO_PROJECT_ID
        ? { projectContext: project, sourceDocuments: [sourceDocument] }
        : null
    },
    async getDocumentReopenSnapshot(projectContextId, sourceDocumentId) {
      if (
        projectContextId !== DEMO_PROJECT_ID ||
        sourceDocumentId !== DEMO_DOCUMENT_ID
      )
        return null
      return {
        projectContext: project,
        sourceDocument,
        sourceRepresentation: {
          sourceRepresentationId: DEMO_REPRESENTATION_ID,
          revisionNumber: 2,
          createdAt: new Date('2026-07-31T12:02:00.000Z'),
        },
        annotationSet: null,
        extractionSchema: null,
        latestAttempt: null,
        latestReviewed: null,
      }
    },
    async getSourceRepresentation(projectContextId, sourceRepresentationId) {
      return projectContextId === DEMO_PROJECT_ID &&
        sourceRepresentationId === DEMO_REPRESENTATION_ID
        ? {
            artifactReference: DEMO_ARTIFACT_REFERENCE,
            artifactSha256: 'c'.repeat(64),
            sourceDocumentId: DEMO_DOCUMENT_ID,
          }
        : null
    },
  }
}
