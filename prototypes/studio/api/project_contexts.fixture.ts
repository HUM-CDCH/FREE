import type { ProjectStore } from '../../../packages/db/src/project-store.js'

export const DEMO_PROJECT_ID = '00000000-0000-4000-8000-000000000044'
export const DEMO_DOCUMENT_ID = '00000000-0000-4000-8000-000000000045'
export const DEMO_REPRESENTATION_ID = '00000000-0000-4000-8000-0000000000a1'
export const DEMO_ARTIFACT_REFERENCE = '00000000-0000-4000-8000-0000000000b1'

/** Deterministic read fixture for contract tests and local API wiring. */
export function projectContextFixture(): ProjectStore {
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
      return [project]
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
        extraction: null,
      }
    },
    async getSourceRepresentation(sourceRepresentationId) {
      return sourceRepresentationId === DEMO_REPRESENTATION_ID
        ? {
            artifactReference: DEMO_ARTIFACT_REFERENCE,
            artifactSha256: 'c'.repeat(64),
          }
        : null
    },
  }
}
