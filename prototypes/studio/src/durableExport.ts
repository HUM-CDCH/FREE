import { zipSync, strToU8 } from 'fflate'
import { createXlsxBlob, serializeCsv, type Table } from 'extraction-result-export'
import type { DurableHistory, DurablePage, DurableRead } from 'extraction/durable-types'
import { durableRequest, durableRoot, readDurable, readDurableHistory } from './durableExtractionApi'

export type Fixed={state:DurableRead;page:DurablePage;history:DurableHistory}
export type BatchExportMember={extractionId:string|null;sourceDocumentId:string;sourceRevisionId:string;status:string;failureMessage:string|null}
export type BatchExportSnapshot={fixed:Fixed;values:DurablePage['values'];member:BatchExportMember}
const encoded=(value:unknown)=>value===undefined?null:JSON.stringify(value)
export function durableExportTables(fixed:Fixed,values:DurablePage['values']):{results:Table;versions:Table;reviews:Table;inputs:Table;processing:Table} {
  const columns=['Extraction','Snapshot','Record','Field','Schema revision','Input selection','Path','Model value','Reviewed value','Review','Processing','Grounding','Evidence','Historical correction','Lineage']
  const rows=values.map(v=>({'Extraction':fixed.state.extractionId,'Snapshot':fixed.page.snapshotVersion,'Record':v.recordId,'Field':v.fieldId,'Schema revision':v.schemaRevisionId,'Input selection':v.selectionId,'Path':encoded(v.path),'Model value':encoded(v.modelValue),'Reviewed value':v.correction?.decision.action==='EDITED'?encoded(v.correction.decision.value):null,'Review':v.correction?.decision.action??'PENDING','Processing':v.processing,'Grounding':v.grounding,'Evidence':encoded(v.evidence),'Historical correction':encoded(v.historicalCorrection),'Lineage':encoded(v.lineage)}))
  const versions=fixed.history.snapshots.filter(s=>s.version<=fixed.page.snapshotVersion).flatMap(s=>s.values.map((v:DurablePage['values'][number])=>({'Snapshot':s.version,'Record':v.recordId,'Field':v.fieldId,'Schema revision':v.schemaRevisionId,'Input selection':v.selectionId,'Model value':encoded(v.modelValue),'Evidence':encoded(v.evidence),'Lineage':encoded(v.lineage)})))
  const reviews=fixed.history.corrections.filter(c=>c.feedbackVersion<=fixed.page.feedbackVersion).map(c=>({'Revision':c.revision,'Feedback version':c.feedbackVersion,'Value':c.valueId,'Schema selection':c.selectionId,'Decision':encoded(c.decision),'Guidance included':c.included,'Candidate':encoded(c.candidate)}))
  const inputs=fixed.history.selections.map(s=>({'Input selection':s.id,'Ordinal':s.ordinal,'Schema revision':s.schemaRevisionId,'Schema':encoded(s.schemaTree),'Requested method':encoded(s.method),'Resolved method':encoded(s.resolved),'Digest':s.digest}))
  return {results:{columns,rows},versions:{columns:['Snapshot','Record','Field','Schema revision','Input selection','Model value','Evidence','Lineage'],rows:versions},reviews:{columns:['Revision','Feedback version','Value','Schema selection','Decision','Guidance included','Candidate'],rows:reviews},inputs:{columns:['Input selection','Ordinal','Schema revision','Schema','Requested method','Resolved method','Digest'],rows:inputs},processing:{columns:['Extraction','State','Snapshot','Feedback version','Source revision','Coverage'],rows:[{'Extraction':fixed.state.extractionId,'State':fixed.page.status,'Snapshot':fixed.page.snapshotVersion,'Feedback version':fixed.page.feedbackVersion,'Source revision':fixed.state.sourceRevisionId,'Coverage':encoded(fixed.page.coverage)}]}}
}
export async function fixedDurableValues(fixed:Fixed) {
  let page=await durableRequest<DurablePage>(`${durableRoot(fixed.state.extractionId)}/values?${new URLSearchParams({snapshotVersion:String(fixed.page.snapshotVersion),feedbackVersion:String(fixed.page.feedbackVersion),limit:'500'})}`)
  const values=[...page.values]
  while(page.next) {page=await durableRequest<DurablePage>(`${durableRoot(fixed.state.extractionId)}/values?${new URLSearchParams(Object.entries(page.next).map(([k,v])=>[k,String(v)]))}`);values.push(...page.values)}
  return values
}
function frozen(fixed:Fixed,values:DurablePage['values']) {
  const manifest={protocol:1,extractionId:fixed.state.extractionId,snapshotVersion:fixed.page.snapshotVersion,feedbackVersion:fixed.page.feedbackVersion,status:fixed.page.status,source:fixed.state.source,coverage:fixed.page.coverage,recall:'unmeasured',values:values.length,
    historyCapturedAt:fixed.history.capturedAt,historyScope:'Complete execution inputs and call history at capture time; result versions and decisions are limited to the named snapshot cuts.'}
  return {manifest,values,history:{...fixed.history,snapshots:fixed.history.snapshots.filter(s=>s.version<=fixed.page.snapshotVersion),corrections:fixed.history.corrections.filter(c=>c.feedbackVersion<=fixed.page.feedbackVersion),
    finalizations:fixed.history.finalizations.filter(f=>f.snapshotVersion<=fixed.page.snapshotVersion&&f.feedbackVersion<=fixed.page.feedbackVersion)}}
}
/** Base64 over UTF-8 is XML-safe, and the prefix prevents spreadsheet formula
 * protection from changing chunks. Concatenate chunks without their prefixes,
 * decode base64, then parse JSON to reconstruct authoritative provenance. */
export function provenanceTable(body:unknown):Table {
  const bytes=strToU8(JSON.stringify(body)),rows=[]
  // Divisible by three: only the final chunk needs base64 padding.
  for(let index=0;index<bytes.length;index+=22500)rows.push({'Part':index/22500+1,
    'JSON base64 chunk':`b64:${btoa(String.fromCharCode(...bytes.subarray(index,index+22500)))}`})
  return {columns:['Part','JSON base64 chunk'],rows}
}
function workbookTable(table:Table):Table {
  return {...table,rows:table.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,typeof value==='string'&&value.length>30000?'[Full value is retained in the Provenance JSON chunks]':value])))}
}
export async function durableExportBlob(fixed:Fixed,values:DurablePage['values'],format:'xlsx'|'csv'):Promise<Blob> {
  const tables=durableExportTables(fixed,values),snapshot=frozen(fixed,values)
  if(format==='xlsx')return createXlsxBlob(workbookTable(tables.results),[
    {sheet:'Model versions',table:workbookTable(tables.versions)},{sheet:'Reviews and feedback',table:workbookTable(tables.reviews)},
    {sheet:'Input selections',table:workbookTable(tables.inputs)},{sheet:'Processing',table:workbookTable(tables.processing)},
    {sheet:'Provenance',table:provenanceTable(snapshot)}])
  return new Blob([new Uint8Array(zipSync(Object.fromEntries([
    ...Object.entries(tables).map(([name,table])=>[`${name}.csv`,strToU8(serializeCsv(table))] as const),
    ['manifest.json',strToU8(JSON.stringify(snapshot.manifest,null,2))],['snapshot.json',strToU8(JSON.stringify(snapshot))],
  ])))],{type:'application/zip'})
}
function download(blob:Blob,name:string) {
  const url=URL.createObjectURL(blob),link=document.createElement('a')
  link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
export async function downloadDurableExport(fixed:Fixed,format:'xlsx'|'csv') {
  const values=await fixedDurableValues(fixed)
  download(await durableExportBlob(fixed,values,format),`extraction-${fixed.state.extractionId}-s${fixed.page.snapshotVersion}.${format==='xlsx'?'xlsx':'zip'}`)
}
/** Batch members keep independent snapshot and review cursors and attribution. */
export async function downloadDurableBatch(batchId:string,members:readonly BatchExportMember[],format:'xlsx'|'csv'):Promise<boolean> {
  const durable:{state:DurableRead;page:DurablePage;member:BatchExportMember}[]=[]
  for(const member of members) {
    if(!member.extractionId)continue
    const loaded=await readDurable(member.extractionId)
    durable.push({...loaded,member})
  }
  if(!durable.length)return false
  const snapshots=[]
  for(const loaded of durable) {
    const fixed={...loaded,history:await readDurableHistory(loaded.state.extractionId)}
    snapshots.push({fixed,values:await fixedDurableValues(fixed),member:loaded.member})
  }
  download(await durableBatchExportBlob(batchId,members,snapshots,format),`batch-${batchId}.${format==='xlsx'?'xlsx':'zip'}`)
  return true
}
export async function durableBatchExportBlob(batchId:string,members:readonly BatchExportMember[],snapshots:readonly BatchExportSnapshot[],format:'xlsx'|'csv'):Promise<Blob> {
  const tables=snapshots.map(s=>durableExportTables(s.fixed,s.values)),columns=tables[0].results.columns
  const results:Table={columns:['Source Document',...columns],rows:snapshots.flatMap((s,index)=>tables[index].results.rows.map(row=>({'Source Document':s.member.sourceDocumentId,...row})))}
  const body={protocol:1,batchId,totalMembers:members.length,members,durable:snapshots.map(s=>({...s.member,...frozen(s.fixed,s.values)})),recall:'unmeasured'}
  const processing:Table={columns:['Source Document','Extraction','State','Failure','Snapshot','Feedback version','Source revision','Coverage'],rows:members.map(member=>{
    const saved=snapshots.find(snapshot=>snapshot.member.sourceDocumentId===member.sourceDocumentId)
    return {'Source Document':member.sourceDocumentId,'Extraction':member.extractionId,'State':saved?.fixed.page.status??member.status,
      'Failure':member.failureMessage,'Snapshot':saved?.fixed.page.snapshotVersion??null,'Feedback version':saved?.fixed.page.feedbackVersion??null,
      'Source revision':saved?.fixed.state.sourceRevisionId??member.sourceRevisionId,'Coverage':saved?encoded(saved.fixed.page.coverage):null}
  })}
  const blob=format==='xlsx'?await createXlsxBlob(workbookTable(results),[{sheet:'Processing',table:workbookTable(processing)},{sheet:'Provenance',table:provenanceTable(body)}]):new Blob([new Uint8Array(zipSync({'results.csv':strToU8(serializeCsv(results)),'processing.csv':strToU8(serializeCsv(processing)),'snapshot.json':strToU8(JSON.stringify(body))}))],{type:'application/zip'})
  return blob
}
