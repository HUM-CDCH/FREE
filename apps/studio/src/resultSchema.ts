import type { DurablePage, DurableRead, ResultSchemaRevision } from 'extraction/durable-types'
import type { RecordScope } from 'extraction/schema'

export type CurrentResultSchema = {
  schemaRevisionId: string; revisionNumber: number; recordScope?: RecordScope | null; extractionSchemaId?: string
}
export const recordScopeLabel = (scope?: RecordScope | null) => scope==='document'?'Article':scope==='records'?'Catalog':null
export const resultSchemaLabel = (schema: Pick<ResultSchemaRevision,'revisionNumber'|'recordScope'>) =>
  `schema revision ${schema.revisionNumber}${schema.recordScope ? ` (${recordScopeLabel(schema.recordScope)})` : ''}`

export type ShownSchema={page:DurablePage;state:DurableRead;current:CurrentResultSchema|null;controlled:boolean;readOnly:boolean}

/** The revisions that made a cut's values, beside the current schema and the run's inputs. */
export function resultSchemaFacts({page,state,current,controlled,readOnly}:ShownSchema) {
  const ids=[...new Set(page.values.map(value=>value.schemaRevisionId))]
  if(ids.length===0&&page.schemaRevisionId)ids.push(page.schemaRevisionId)
  const revisions=page.schemaRevisions??[]
  const producing=ids.map(id=>revisions.find(revision=>revision.schemaRevisionId===id))
  const mismatch=Boolean(current&&ids.some(id=>id!==current.schemaRevisionId))
  const active=state.schemaRevisions?.find(revision=>revision.schemaRevisionId===state.selection.schemaRevisionId)
  const pending=state.pendingSelection&&state.pendingSelection.id!==state.selection.id
    ?state.schemaRevisions?.find(revision=>revision.schemaRevisionId===state.pendingSelection.schemaRevisionId):null
  const continuing=controlled&&!readOnly&&!state.pendingSelection&&active&&current&&active.schemaRevisionId!==current.schemaRevisionId&&['PAUSED','FAILED'].includes(state.status)
  const sameScope=current?.recordScope===(state.strategy==='ARTICLE'?'document':'records')
  const quiet=producing.length===1&&!mismatch&&!pending&&!continuing&&!(controlled&&!readOnly&&state.pendingSelection)?producing[0]??null:null
  return {ids,producing,mismatch,active,pending,continuing,sameScope,quiet}
}

/** The one current revision that made these results when there is nothing else to say: the status line names it. */
export const quietRevision=(shown:ShownSchema)=>resultSchemaFacts(shown).quiet
