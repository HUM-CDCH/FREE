import { randomUUID } from 'node:crypto'
import { withPoolClientTransaction } from 'db'
import { initializeDurableExtraction } from 'extraction/durable'
import type { DurableValue } from 'extraction/durable-contract'
import type { SchemaNode } from 'extraction/schema'
import type { InteractiveDocument } from './interactiveStack.js'

/** Saved producer data in the guarded browser database; admissions stay OFF. */
export async function savedExtraction(fixture:InteractiveDocument,nodes:SchemaNode[],modelValues:unknown[],status:'QUEUED'|'RUNNING'|'PAUSED'|'FAILED'|'STOPPED'|'COMPLETED'='PAUSED',options:{records?:unknown[][];schemaRevisionId?:string;intent?:'RUN'|'PAUSE'|'STOP';modelEvidence?:Readonly<Record<string,DurableValue['evidence']>>}={}) {
  const strategy=options.records?'CATALOG':'ARTICLE',settings=options.records?{generic:null}:{article:null}
  const id=randomUUID(),schemaRevisionId=options.schemaRevisionId??randomUUID(),tree={recordDescription:'One interactive record.',schemaNodes:nodes}
  await withPoolClientTransaction(async(_transaction,client)=> {
    if(!options.schemaRevisionId)await client.query(`INSERT INTO public."schemaRevision" (id,"extractionSchemaId","revisionNumber",origin,"schemaTree","recordScope")
      SELECT $1,$2,coalesce(max("revisionNumber"),0)+1,'RESEARCHER_EDIT',$3,$4 FROM public."schemaRevision" WHERE "extractionSchemaId"=$2`,
      [schemaRevisionId,fixture.extractionSchemaId,tree,options.records?'records':'document'])
    await client.query(`INSERT INTO public.extraction (id,"sourceDocumentId","sourceRepresentationRevisionId","schemaRevisionId",strategy,"requestedSettings") VALUES ($1,$2,$3,$4,$5,$6)`,
      [id,fixture.sourceDocumentId,fixture.sourceRepresentationRevisionId,schemaRevisionId,strategy,settings])
    await initializeDurableExtraction(client,id,{projectContextId:fixture.projectContextId,sourceRepresentationRevisionId:fixture.sourceRepresentationRevisionId,
      schemaRevisionId,schemaTree:tree,strategy,catalogRecipe:null,preprocessId:`kei-exp:e2e-${fixture.sourceRepresentationRevisionId}:g1`,requestedModels:null,requestedSettings:settings})
    const head=(await client.query('SELECT * FROM extraction_runtime.head WHERE id=$1',[id])).rows[0]
    const values=(options.records??[modelValues]).flatMap((record,recordIndex)=>nodes.map((node,index)=>{
      const valueId=options.records?`record-${recordIndex}:${node.id}`:node.id,evidence=options.modelEvidence?.[valueId]??[]
      return {id:valueId,recordId:options.records?`record-${recordIndex}`:'document',fieldId:node.id,
      path:['records',recordIndex,node.name],selectionId:head.selectionId,schemaRevisionId,node,
      modelValue:record[index],evidence,grounding:evidence.length?'grounded':'ungrounded',processing:'saved',lineage:[]}}))
    await client.query(`INSERT INTO extraction_runtime.snapshot (id,"extractionId",version,"selectionId",digest,values,coverage) VALUES ($1,$2,1,$3,$4,$5,'{"incomplete":true}')`,
      [randomUUID(),id,head.selectionId,'a'.repeat(64),JSON.stringify(values)])
    await client.query('UPDATE extraction_runtime.head SET intent=$2,acknowledgement=$3,"snapshotVersion"=1 WHERE id=$1',[id,options.intent??(status==='STOPPED'?'STOP':['QUEUED','RUNNING','COMPLETED'].includes(status)?'RUN':'PAUSE'),status])
    await client.query('UPDATE extraction_runtime.attempt SET outcome=$2 WHERE id=$1',[head.attemptId,['QUEUED','RUNNING'].includes(status)?null:status])
    await client.query('UPDATE extraction_runtime.dispatch SET received=true WHERE id=$1',[head.attemptId])
  })
  return {id,schemaRevisionId}
}
