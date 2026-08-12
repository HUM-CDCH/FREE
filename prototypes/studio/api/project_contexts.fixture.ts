import type { ProjectStore } from '../../../packages/db/src/project-store.js'

export const DEMO_PROJECT_ID = '00000000-0000-4000-8000-000000000044'

/** Deterministic read fixture for contract tests and local API wiring. */
export function projectContextFixture(): ProjectStore {
  const project = {
    projectContextId: DEMO_PROJECT_ID,
    name: 'Ellekilde, TAK 1355',
    createdAt: new Date('2026-07-31T12:00:00.000Z'),
  }
  return {
    async listProjectContexts() {
      return [project]
    },
    async getProjectContextWithDocuments(id) {
      return id === DEMO_PROJECT_ID
        ? {
            projectContext: project,
            sourceDocuments: [
              {
                sourceDocumentId: '00000000-0000-4000-8000-000000000045',
                name: 'Beretning_Ellekilde_8_13.pdf',
                createdAt: new Date('2026-07-31T12:01:00.000Z'),
              },
            ],
          }
        : null
    },
  }
}
