import type { ResultSchemaRevision } from 'extraction/durable-types'
import type { RecordScope } from 'extraction/schema'

export type CurrentResultSchema = {
  schemaRevisionId: string; revisionNumber: number; recordScope?: RecordScope | null; extractionSchemaId?: string
}
export const recordScopeLabel = (scope?: RecordScope | null) => scope==='document'?'Article':scope==='records'?'Catalog':null
export const resultSchemaLabel = (schema: Pick<ResultSchemaRevision,'revisionNumber'|'recordScope'>) =>
  `schema revision ${schema.revisionNumber}${schema.recordScope ? ` (${recordScopeLabel(schema.recordScope)})` : ''}`
