import {
  buildDurableEvidenceTable, buildExportTable, buildIdentityTable, createExportFilename, createFieldRegistry, createXlsxBlob,
  downloadBlob, durableRecords, serializeCsv, EVIDENCE_SHEET, EXTRACTION_SHEET, ROOT_ROWS,
  type CellValue, type CompanionSheet, type ExportChoices, type ExportFormat, type Table,
} from 'extraction-result-export'
import type { DurablePage, DurableRead } from 'extraction/durable-types'
import { readDurable, readValues } from './durableExtractionApi'

/** One fixed cut of a durable Extraction: its state and the result page (a named result and decision version) the
 * researcher has open. The export reads nothing else: no history, no model calls, no other versions. */
export type Fixed={state:DurableRead;page:DurablePage}
export type BatchExportMember={extractionId:string;sourceDocumentId:string;sourceDocumentName:string;sourceRevisionId:string;status:string}
export type BatchExportSnapshot={fixed:Fixed;values:DurablePage['values'];member:BatchExportMember}
export const DEFAULT_EXPORT_CHOICES:ExportChoices={rowsRepresent:ROOT_ROWS,otherRepeatedFields:'preserve'}
export const MEMBERS_SHEET='Members'
const SOURCE_DOCUMENT='Source Document',SOURCE_DOCUMENT_ID='Source Document ID',BATCH_EXTRACTION_ID='Batch Extraction ID'
/** Excel holds 32,767 characters in a cell; a longer composite value is cut with a note, never silently. */
const CELL_LIMIT=32000
const csvBlob=(table:Table)=>new Blob([serializeCsv(table)],{type:'text/csv;charset=utf-8'})
const fitCell=(value:CellValue):CellValue=>typeof value==='string'&&value.length>CELL_LIMIT?`${value.slice(0,CELL_LIMIT)}… [cut: the full value is in Studio]`:value
const fitTable=(table:Table):Table=>({...table,rows:table.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,fitCell(value)])))})
const toneOf=(status:string)=>status.charAt(0)+status.slice(1).toLowerCase()

/** Schema fields keep their names; attribution columns move to an unused suffix. */
function attributionColumn(base:string,columns:readonly string[]):string {
  let column=base
  for(let ordinal=2;columns.includes(column);ordinal+=1)column=`${base} (${ordinal})`
  return column
}

/** The tables of one fixed cut: the research table, the compact Extraction identity and the Evidence sheet. */
export function durableExportTables(fixed:Fixed,values:DurablePage['values'],choices:ExportChoices,sourceName:string):{results:Table;extraction:Table;evidence:Table} {
  const registry=createFieldRegistry(values,fixed.state.selection?.schemaTree?.schemaNodes)
  const records=durableRecords(values,registry)
  const results=buildExportTable(registry.schemaNodes,records.map(record=>record.fields),choices)
  const revisions=[...new Set(values.map(value=>value.schemaRevisionId))]
  const extraction=buildIdentityTable([
    ['Extraction ID',fixed.state.extractionId],['Strategy',fixed.state.strategy],['Source Document',sourceName],
    ['Source Representation Revision ID',fixed.state.sourceRevisionId],['State',toneOf(fixed.page.status)],
    ['Results version',fixed.page.snapshotVersion],['Decisions version',fixed.page.feedbackVersion],
    ['Review saved',fixed.page.finalization?'Yes':'Not saved'],
    ['Inputs version',fixed.state.selection?.ordinal??null],['Producing Schema Revision IDs',revisions.join(', ')||'None'],
    ['Records',records.length],['Fields',registry.schemaNodes.length],['Values',values.length],
    ['Approved',fixed.page.reviewCounts.approved],['Edited',fixed.page.reviewCounts.edited],['Rejected',fixed.page.reviewCounts.rejected],['To check',fixed.page.reviewCounts.toCheck],
    ...registry.ambiguous.map(({name,columns})=>[`Field "${name}" produced under more than one type`,columns.join(', ')] as const),
    ['Rows represent',choices.rowsRepresent===ROOT_ROWS?'Root result':choices.rowsRepresent],['Other repeated fields',choices.otherRepeatedFields==='preserve'?'Preserved as indexed columns':'Omitted'],
    ['Record recall','Unmeasured'],['Exported at',new Date().toISOString()],
  ])
  return {results,extraction,evidence:buildDurableEvidenceTable(values)}
}

/** Every value of the fixed cut: the open page already holds them all; only a partial page is read again, by value pages. */
export async function fixedDurableValues(fixed:Fixed,signal?:AbortSignal):Promise<DurablePage['values']> {
  if(fixed.page.values.length>=fixed.page.total)return fixed.page.values
  const page=await readValues(fixed.state.extractionId,{snapshotVersion:fixed.page.snapshotVersion,feedbackVersion:fixed.page.feedbackVersion},signal)
  return page.values
}

/** CSV holds the research table alone; the workbook adds the Extraction and Evidence sheets. */
export async function durableExportBlob(fixed:Fixed,values:DurablePage['values'],format:ExportFormat,choices:ExportChoices=DEFAULT_EXPORT_CHOICES,sourceName=fixed.state.extractionId):Promise<Blob> {
  const tables=durableExportTables(fixed,values,choices,sourceName)
  if(format==='csv')return csvBlob(tables.results)
  return createXlsxBlob(fitTable(tables.results),[{sheet:EXTRACTION_SHEET,table:fitTable(tables.extraction)},{sheet:EVIDENCE_SHEET,table:fitTable(tables.evidence)}])
}

export const exportFilename=(sourceName:string,snapshotVersion:number,format:ExportFormat)=>createExportFilename(sourceName,format,`extraction-result-s${snapshotVersion}`)

export async function downloadDurableExport(fixed:Fixed,format:ExportFormat,choices:ExportChoices,sourceName:string,signal?:AbortSignal):Promise<void> {
  const values=await fixedDurableValues(fixed,signal)
  const blob=await durableExportBlob(fixed,values,format,choices,sourceName)
  signal?.throwIfAborted()
  downloadBlob(blob,exportFilename(sourceName,fixed.page.snapshotVersion,format))
}

/** Batch members keep independent result and decision versions; each row names its Source Document. */
export async function downloadDurableBatch(batch:{batchExtractionId:string;name:string},members:readonly BatchExportMember[],format:ExportFormat,choices:ExportChoices=DEFAULT_EXPORT_CHOICES,signal?:AbortSignal):Promise<boolean> {
  const snapshots:BatchExportSnapshot[]=[]
  for(const member of members) {
    const fixed=await readDurable(member.extractionId,signal)
    snapshots.push({fixed,values:await fixedDurableValues(fixed,signal),member})
  }
  if(!snapshots.length)return false
  const blob=await durableBatchExportBlob(batch,members,snapshots,format,choices)
  signal?.throwIfAborted()
  downloadBlob(blob,createExportFilename(batch.name,format,'batch-extraction-results'))
  return true
}

/** One table over every member, projected through the fields their values were produced with (one registry, so a
 * field produced under two types stays two named columns), with the member's Source Document on each row. */
export async function durableBatchExportBlob(batch:{batchExtractionId:string},members:readonly BatchExportMember[],snapshots:readonly BatchExportSnapshot[],format:ExportFormat,choices:ExportChoices=DEFAULT_EXPORT_CHOICES):Promise<Blob> {
  const registry=createFieldRegistry(snapshots.flatMap(snapshot=>snapshot.values),snapshots.flatMap(snapshot=>snapshot.fixed.state.selection?.schemaTree?.schemaNodes??[]))
  const projected=snapshots.map(snapshot=>({snapshot,records:durableRecords(snapshot.values,registry)}))
  const tables=projected.map(({snapshot,records})=>({snapshot,table:buildExportTable(registry.schemaNodes,records.map(record=>record.fields),choices)}))
  const columns:string[]=[]
  for(const {table} of tables)for(const column of table.columns)if(!columns.includes(column))columns.push(column)
  const attribution:string[]=[]
  for(const base of [SOURCE_DOCUMENT,SOURCE_DOCUMENT_ID,BATCH_EXTRACTION_ID])attribution.push(attributionColumn(base,[...columns,...attribution]))
  const [document,documentId,batchId]=attribution as [string,string,string]
  const results:Table={columns:[...attribution,...columns],rows:tables.flatMap(({snapshot,table})=>table.rows.map(row=>({
    [document]:snapshot.member.sourceDocumentName,[documentId]:snapshot.member.sourceDocumentId,[batchId]:batch.batchExtractionId,...row})))}
  if(format==='csv')return csvBlob(results)
  const membersTable:Table={columns:[SOURCE_DOCUMENT,SOURCE_DOCUMENT_ID,'Extraction ID','State','Results version','Decisions version','Review saved','Values','Source Representation Revision ID'],rows:members.map(member=> {
    const saved=snapshots.find(snapshot=>snapshot.member.extractionId===member.extractionId)
    return {[SOURCE_DOCUMENT]:member.sourceDocumentName,[SOURCE_DOCUMENT_ID]:member.sourceDocumentId,'Extraction ID':member.extractionId,
      'State':toneOf(saved?.fixed.page.status??member.status),'Results version':saved?.fixed.page.snapshotVersion??null,'Decisions version':saved?.fixed.page.feedbackVersion??null,
      'Review saved':saved?saved.fixed.page.finalization?'Yes':'Not saved':null,'Values':saved?.values.length??null,'Source Representation Revision ID':saved?.fixed.state.sourceRevisionId??member.sourceRevisionId}
  })}
  const evidenceRows=snapshots.flatMap(snapshot=>buildDurableEvidenceTable(snapshot.values).rows.map(row=>({[SOURCE_DOCUMENT]:snapshot.member.sourceDocumentName,...row})))
  const evidence:Table={columns:[SOURCE_DOCUMENT,...buildDurableEvidenceTable([]).columns],rows:evidenceRows}
  const companions:CompanionSheet[]=[{sheet:MEMBERS_SHEET,table:fitTable(membersTable)},{sheet:EVIDENCE_SHEET,table:fitTable(evidence)}]
  return createXlsxBlob(fitTable(results),companions)
}
