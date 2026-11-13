import type { SchemaEditorPersistence } from '../currentSchemaRevision'

/** Inert defaults for component tests; tests of durable behavior use the real adapter. */
export function testSchemaPersistence(overrides: Partial<SchemaEditorPersistence> = {}): SchemaEditorPersistence {
  return {
    modelContext: revision => ({ projectContextId: 'test-project', extractionSchemaId: revision.extractionSchemaId, schemaRevisionId: revision.schemaRevisionId }),
    edit() {}, setRecordScope() {}, extractionSchemaId: () => null,
    projectContextId: () => 'test-project',
    initialize: async () => { throw new Error('Unexpected initialization') },
    flush: async () => null, saveState: () => null, reloadCurrent: () => null,
    listRevisions: async () => [], getRevision: async () => { throw new Error('Unexpected history request') },
    onChange: () => () => {}, dispose() {}, ...overrides,
  }
}
