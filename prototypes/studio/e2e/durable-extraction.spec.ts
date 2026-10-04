import { expect,test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { pool,withPoolClientTransaction } from 'db'
import { initializeDurableExtraction } from 'extraction/durable'
import { prepareInteractiveDocument,INTERACTIVE_SCHEMA_NODES } from './interactiveStack.js'
import { loginResearcher } from './auth.js'

// Admissions remain disabled. This fixture publishes retained work into this
// runner's guarded disposable database; every browser read/write is authenticated.
test('saved live review survives reload, rejects another owner and exports its fixed snapshot',async({page,browser})=> {
  page.on('pageerror',error=>console.error('durable browser error:',error.message))
  page.on('console',message=>{if(message.type()==='error')console.error('durable browser console:',message.text())})
  const fixture=await prepareInteractiveDocument(page,{hasKey:false})
  try {
    const revision=(await fixture.schemaRevisions())[0].schemaRevisionId,id=randomUUID()
    await withPoolClientTransaction(async(_tx,client)=> {
      await client.query(`INSERT INTO public.extraction (id,"sourceDocumentId","sourceRepresentationRevisionId","schemaRevisionId",strategy,"requestedSettings") VALUES ($1,$2,$3,$4,'ARTICLE',$5)`,[id,fixture.sourceDocumentId,fixture.sourceRepresentationRevisionId,revision,{article:null}])
      await initializeDurableExtraction(client,id,{projectContextId:fixture.projectContextId,sourceRepresentationRevisionId:fixture.sourceRepresentationRevisionId,schemaRevisionId:revision,schemaTree:{recordDescription:'One interactive record.',schemaNodes:INTERACTIVE_SCHEMA_NODES},strategy:'ARTICLE',catalogRecipe:null,preprocessId:`kei-exp:e2e-${fixture.sourceRepresentationRevisionId}:g1`,requestedModels:null,requestedSettings:{article:null}})
      const head=(await client.query('SELECT * FROM extraction_runtime.head WHERE id=$1',[id])).rows[0]
      const values=INTERACTIVE_SCHEMA_NODES.map(node=>({id:node.id,recordId:'document',fieldId:node.id,path:['records',0,node.name],selectionId:head.selectionId,schemaRevisionId:revision,node,modelValue:node.id==='title'?'Original title':2026,evidence:[],grounding:'ungrounded',processing:'saved',lineage:[]}))
      await client.query(`INSERT INTO extraction_runtime.snapshot (id,"extractionId",version,"selectionId",digest,values,coverage) VALUES ($1,$2,1,$3,$4,$5,'{"incomplete":true}')`,[randomUUID(),id,head.selectionId,'a'.repeat(64),JSON.stringify(values)])
      await client.query(`UPDATE extraction_runtime.head SET intent='PAUSE',acknowledgement='PAUSED',"snapshotVersion"=1 WHERE id=$1`,[id])
      await client.query(`UPDATE extraction_runtime.attempt SET outcome='PAUSED' WHERE id=$1`,[head.attemptId])
      await client.query('UPDATE extraction_runtime.dispatch SET received=true WHERE id=$1',[head.attemptId])
    })
    await fixture.open()
    await page.getByRole('tab',{name:'Results'}).click()
    await expect(page.getByText('Original title',{exact:false})).toBeVisible()
    await page.getByRole('button',{name:'Review value',exact:true}).first().click()
    await page.getByRole('textbox',{name:'title · string'}).fill('Corrected without Evidence')
    await page.getByRole('button',{name:'Save correction',exact:true}).click()
    await expect(page.getByText('"Corrected without Evidence"',{exact:true})).toBeVisible()
    await page.reload()
    await page.getByRole('tab',{name:'Results'}).click()
    await expect(page.getByText('"Corrected without Evidence"',{exact:true})).toBeVisible()
    await page.getByRole('button',{name:'Review saved decision'}).click()
    await expect(page.getByRole('textbox',{name:'title · string'})).toHaveValue('Corrected without Evidence')
    await page.getByRole('button',{name:'Close',exact:true}).click()
    const download=page.waitForEvent('download')
    await page.getByRole('button',{name:'Export CSV bundle'}).click()
    const saved=await download;expect(saved.suggestedFilename()).toContain('-s1.zip')
    await page.screenshot({path:'test-results/durable-review-desktop.png',fullPage:true})
    await page.setViewportSize({width:375,height:812})
    await page.screenshot({path:'test-results/durable-review-mobile.png',fullPage:true})
    const otherContext=await browser.newContext(),other=await otherContext.newPage()
    try {
      await loginResearcher(other,randomUUID())
      const denied=await other.request.post(`/api/extractions/${id}/durable/values/title`,{data:{snapshotVersion:1,expectedRevision:1,action:'EDITED',value:'Another owner' ,included:true,evidence:[]},headers:{Origin:new URL(fixture.url,other.url()).origin}})
      expect(denied.status()).toBe(404)
    } finally {await otherContext.close()}
    const ownState=await page.request.get(`/api/extractions/${id}/durable`)
    expect((await ownState.json()).extractionId).toBe(id)
    expect((await pool.query('SELECT count(*)::int AS n FROM extraction_runtime.correction WHERE "extractionId"=$1',[id])).rows[0].n).toBe(1)
  } finally {await fixture.close()}
})
