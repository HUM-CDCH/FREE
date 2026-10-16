import type { DurablePage, DurableRead, ResultSchemaRevision } from 'extraction/durable-types'
import { recordScopeLabel,resultSchemaLabel,type CurrentResultSchema } from './resultSchema'

/** A saved cut's values name their producers; the head's inputs may already have changed. */
export function ResultSchemaNotice({page,state,current,controlled,readOnly,onSchema}:{
  page:DurablePage;state:DurableRead;current:CurrentResultSchema|null;controlled:boolean;readOnly:boolean;onSchema?:()=>void
}) {
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
  if(ids.length===0)return null
  const label=(revision:ResultSchemaRevision)=>`${current?.extractionSchemaId&&current.extractionSchemaId!==revision.extractionSchemaId?`${revision.name} · `:''}${resultSchemaLabel(revision)}`
  return <div className={`shrink-0 space-y-1 border-b border-line px-3 py-2 text-compact ${mismatch?'bg-stale-soft text-stale-ink':'text-ink-muted'}`} aria-label="Results schema">
    <p className="m-0">{producing.some(revision=>!revision)?'The producing schema revision could not be read.'
      :producing.length>1?`These results contain values from multiple schema revisions: ${producing.map(revision=>label(revision!)).join(', ')}.`
        :`${mismatch?'These results use':'Made with'} ${label(producing[0]!)}.`}</p>
    {mismatch&&current&&<p className="m-0">The current schema is revision {current.revisionNumber}{current.recordScope?` (${recordScopeLabel(current.recordScope)})`:''}.</p>}
    {pending&&<p className="m-0">Pending inputs use {resultSchemaLabel(pending)}.</p>}
    {controlled&&!readOnly&&state.pendingSelection&&<p className="m-0">Apply or discard the pending inputs before resuming.</p>}
    {continuing&&<p className="m-0">{state.status==='FAILED'?'Retry':'Resume'} continues this extraction with {resultSchemaLabel(active)}.{' '}
      {!current.recordScope?'Choose Article or Catalog in Schema before starting a new extraction.'
        :sameScope?'Use Change inputs to adopt a revised schema, or stop this extraction and run again.'
          :'To use the current schema, stop this extraction, then Run extraction. Its saved values and decisions stay.'}</p>}
    {mismatch&&onSchema&&<button type="button" className="cursor-pointer text-accent underline" onClick={onSchema}>Open Schema</button>}
  </div>
}
