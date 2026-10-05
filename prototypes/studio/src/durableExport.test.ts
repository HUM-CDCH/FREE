import { describe,it,expect,vi,afterEach } from 'vitest'
import { unzipSync,strFromU8 } from 'fflate'
import ExcelJS from 'exceljs'
import { createXlsxBlob } from 'extraction-result-export'
import { durableBatchExportBlob,durableExportBlob,durableExportTables,fixedDurableValues,provenanceTable,type Fixed } from './durableExport'
vi.mock('./auth/authenticatedFetch',()=>({authenticatedFetch:(...args:unknown[])=>fetch(...args as Parameters<typeof fetch>)}))
afterEach(()=>vi.unstubAllGlobals())
const decodeProvenance=(chunks:string[])=>JSON.parse(strFromU8(Uint8Array.from(atob(chunks.map(chunk=>chunk.slice(4)).join('')),char=>char.charCodeAt(0))))
const values=[{id:'flag',recordId:'record',fieldId:'flag',path:['records',0,'flag'],selectionId:'used',schemaRevisionId:'historical',node:{id:'flag',name:'flag',type:'boolean'},modelValue:false,evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null},
 {id:'items',recordId:'record',fieldId:'items',path:['records',0,'items'],selectionId:'used',schemaRevisionId:'historical',node:{id:'items',name:'items',type:'array',itemType:'string'},modelValue:['Alice','Bob'],evidence:[],links:[],grounding:'provisional',processing:'saved',lineage:['earlier:items'],correction:{decision:{action:'EDITED',value:['Corrected'],evidence:[],included:true}},historicalCorrection:null}]
const fixed={state:{extractionId:'extraction',sourceRevisionId:'source',source:{generation:'g1'}},page:{snapshotVersion:1,feedbackVersion:2,status:'PAUSED',coverage:{incomplete:true},values,total:2},history:{selections:[{id:'used',ordinal:1,schemaRevisionId:'historical',schemaTree:{schemaNodes:values.map(v=>v.node)},method:{},resolved:{},digest:'digest'}],snapshots:[{version:1,values},{version:2,values:[]}],corrections:[{revision:1,feedbackVersion:2,valueId:'items',selectionId:'used',decision:{action:'EDITED',value:['Corrected']},included:true,candidate:{grounded:false}},{revision:2,feedbackVersion:3}],captures:[{request:{body:'x'.repeat(66000)+'😀'}}],effective:[],plans:[],attempts:[],failedCalls:[],finalizations:[]}} as unknown as Fixed

describe('durable retained exports',()=> {
 it('preserves booleans, composite values, revisions and ungrounded decisions in CSV bundles',async()=> {
   const blob=await durableExportBlob(fixed,fixed.page.values,'csv')
   const files=unzipSync(new Uint8Array(await blob.arrayBuffer()))
   const snapshot=JSON.parse(strFromU8(files['snapshot.json']))
   expect(snapshot.values[0].modelValue).toBe(false)
   expect(snapshot.values[1].correction.decision.value).toEqual(['Corrected'])
   expect(snapshot.history.snapshots).toHaveLength(1);expect(snapshot.history.corrections).toHaveLength(1)
   expect(snapshot.manifest.status).toBe('PAUSED')
   expect(strFromU8(files['results.csv'])).toContain('historical')
   expect(durableExportTables(fixed,fixed.page.values).results.rows[0]['Model value']).toBe('false')
 })
 it('round-trips full provider inputs beyond the Excel cell limit through provenance chunks',async()=> {
   const blob=await durableExportBlob(fixed,fixed.page.values,'xlsx')
   const workbook=new ExcelJS.Workbook()
   await workbook.xlsx.load(await blob.arrayBuffer())
   const sheet=workbook.getWorksheet('Provenance')!,chunks:string[]=[]
   sheet.eachRow((row,index)=>{if(index>1)chunks.push(String(row.getCell(2).value))})
   const restored=decodeProvenance(chunks)
   expect(restored.history.captures).toEqual(fixed.history.captures)
   expect(chunks.every(part=>part.startsWith('b64:')&&part.length<=30004)).toBe(true)
   const raw=provenanceTable(fixed.history)
   expect(decodeProvenance(raw.rows.map(row=>String(row['JSON base64 chunk'])))).toEqual(fixed.history)
 })
 it('round-trips Unicode and formula-looking text exactly at workbook boundaries',async()=> {
   for(const text of ['😀','=1+1','+cmd','-1','@formula']) {
     const prefix=JSON.stringify({payload:''}).indexOf('""')+1
     const body={payload:'x'.repeat(30000-prefix-(text==='😀'?1:0))+text+'x'.repeat(40000)}
     const serialized=JSON.stringify(body)
     if(text==='😀')expect(serialized.charCodeAt(29999)).toBe(0xd83d)
     else expect(serialized[30000]).toBe(text[0])
     const workbook=new ExcelJS.Workbook()
     const blob=await createXlsxBlob({columns:['Value'],rows:[]},[{sheet:'Provenance',table:provenanceTable(body)}])
     await workbook.xlsx.load(await blob.arrayBuffer())
     const chunks:string[]=[];workbook.getWorksheet('Provenance')!.eachRow((row,index)=>{if(index>1)chunks.push(String(row.getCell(2).value))})
     expect(decodeProvenance(chunks)).toEqual(body)
   }
 })
 it('collects all fixed pages independently of later result and feedback publications',async()=> {
   const urls:string[]=[]
   vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
     urls.push(url)
     const next=urls.length===1?{snapshotVersion:1,feedbackVersion:2,offset:500,limit:500}:null
     return Response.json({...fixed.page,values:urls.length===1?[fixed.page.values[0]]:[fixed.page.values[1]],next})
   }))
   expect(await fixedDurableValues(fixed)).toEqual(fixed.page.values)
   expect(urls).toHaveLength(2)
   expect(urls.every(url=>url.includes('snapshotVersion=1')&&url.includes('feedbackVersion=2'))).toBe(true)
 })
 it('exports durable batches with all member states and independent producing schemas',async()=> {
   const members=[
     {extractionId:'extraction',sourceDocumentId:'one',sourceRevisionId:'source',status:'RUNNING'},
     {extractionId:'second',sourceDocumentId:'two',sourceRevisionId:'second-source',status:'FAILED'},
     {extractionId:'pending',sourceDocumentId:'pending',sourceRevisionId:'pending-source',status:'QUEUED'},
   ]
   const second={...fixed,state:{...fixed.state,extractionId:'second',sourceRevisionId:'second-source'},
     page:{...fixed.page,snapshotVersion:4,feedbackVersion:9,status:'FAILED'}} as Fixed
   const secondValues=[{...values[0],selectionId:'numeric-selection',schemaRevisionId:'numeric-revision',modelValue:42}] as unknown as Fixed['page']['values']
   for(const format of ['csv','xlsx'] as const) {
     const blob=await durableBatchExportBlob('batch',members,[{fixed,values:fixed.page.values,member:members[0]},
       {fixed:second,values:secondValues,member:members[1]}],format)
     let body:Record<string,unknown>
     if(format==='csv') {
       const files=unzipSync(new Uint8Array(await blob.arrayBuffer()))
       body=JSON.parse(strFromU8(files['snapshot.json']))
       expect(strFromU8(files['processing.csv'])).toContain('pending-source')
       expect(files['legacy.csv']).toBeUndefined()
       expect(strFromU8(files['results.csv'])).toContain('numeric-revision')
     } else {
       const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(await blob.arrayBuffer())
       const chunks:string[]=[];workbook.getWorksheet('Provenance')!.eachRow((row,index)=>{if(index>1)chunks.push(String(row.getCell(2).value))})
       body=decodeProvenance(chunks)
       expect(workbook.getWorksheet('Processing')!.rowCount).toBe(4)
       expect(workbook.getWorksheet('Legacy results')).toBeUndefined()
     }
     expect(body.totalMembers).toBe(3);expect(body.members).toEqual(members)
     const saved=body.durable as {manifest:{snapshotVersion:number;feedbackVersion:number};values:typeof values}[]
     expect(saved.map(s=>s.manifest.snapshotVersion)).toEqual([1,4])
     expect(saved.map(s=>s.manifest.feedbackVersion)).toEqual([2,9])
     expect(saved[0].values[0].modelValue).toBe(false);expect(saved[1].values[0].modelValue).toBe(42)
   }
 })
})
