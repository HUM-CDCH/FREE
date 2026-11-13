import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SchemaRevision } from '../shared/schemaRevision.contract'
import type { SchemaEditorController, SchemaEditorSnapshot } from './currentSchemaRevision'
import { sameSchemaDefinition } from './schemaDefinitionEquality'
import { getSchemaRevision } from './schemaRevisions'

/** A revision defines the template the editor has saved: its fields, record description and Article/Catalog. */
export function definesSavedTemplate(revision: SchemaRevision, snapshot: SchemaEditorSnapshot): boolean {
  return snapshot.draft !== null && snapshot.extractableSchemaRevisionId !== null &&
    sameSchemaDefinition(revision, snapshot.draft) && revision.recordScope === snapshot.recordScope
}

/**
 * Whether the revision a run used, when it is not the current one, still defines the current template: a new revision
 * can define the same one (one made again from history). Read from the server and compared once per pair of revisions;
 * null while unknown, where nothing is saved to compare with, or when the run's revision cannot be read (a revision of
 * another Extraction Schema is not read as this one's).
 */
export function useSameTemplateAsRun(schema: SchemaEditorController, runRevisionId: string | null): boolean | null {
  const snap = useSyncExternalStore(schema.subscribe, schema.snapshot)
  const currentId = snap.extractableSchemaRevisionId
  const extractionSchemaId = snap.extractionSchemaId
  const key = runRevisionId && currentId && extractionSchemaId && runRevisionId !== currentId
    ? `${extractionSchemaId}:${runRevisionId}:${currentId}` : null
  const [compared, setCompared] = useState<{ key: string; same: boolean | null } | null>(null)
  useEffect(() => {
    const projectContextId = schema.operationScope()?.projectContextId
    if (!key || !projectContextId || !runRevisionId || !extractionSchemaId) return
    const controller = new AbortController()
    getSchemaRevision(projectContextId, extractionSchemaId, runRevisionId, controller.signal)
      .then((revision) => {
        if (!controller.signal.aborted) setCompared({ key, same: definesSavedTemplate(revision, schema.snapshot()) })
      })
      .catch(() => {
        if (!controller.signal.aborted) setCompared({ key, same: null })
      })
    return () => controller.abort()
  }, [key, schema, runRevisionId, extractionSchemaId])
  return key !== null && compared?.key === key ? compared.same : null
}
