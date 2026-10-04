import { expect,test,type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { unzipSync, strFromU8 } from 'fflate'
import { canonicalPackageStore,pool,withPoolClientTransaction } from 'db'
import { packCanonicalPackage } from '../../../packages/db/src/artifact-store.js'
import { initializeDurableExtraction } from 'extraction/durable'
import { prepareInteractiveDocument,INTERACTIVE_SCHEMA_NODES } from './interactiveStack.js'
import { loginResearcher } from './auth.js'
import { savedExtraction } from './durableFixtures.js'

test.beforeEach(({page})=> {
  page.on('pageerror',error=>console.error('durable browser error:',error.message))
  page.on('requestfailed',request=>console.error('durable browser request failed:',request.url(),request.failure()?.errorText))
})

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
    await page.locator('#rail-tab-results').click()
    await expect(page.getByText('Original title',{exact:false})).toBeVisible()
    await page.getByRole('button',{name:/To check title Original title/}).click()
    await page.getByRole('button',{name:'Edit',exact:true}).click()
    await page.getByRole('textbox',{name:'Reviewed value'}).fill('Corrected without Evidence')
    await page.getByRole('button',{name:'Save edit',exact:true}).click()
    await page.getByRole('button',{name:'All',exact:true}).click()
    await expect(page.getByText('Corrected without Evidence',{exact:true})).toBeVisible()
    await page.reload()
    await page.locator('#rail-tab-results').click()
    await page.getByRole('button',{name:'All',exact:true}).click()
    await expect(page.getByText('Corrected without Evidence',{exact:true})).toBeVisible()
    await page.getByRole('button',{name:/Edited title Corrected without Evidence/}).click()
    await expect(page.getByText('Edited · saved',{exact:true})).toHaveCount(0)
    await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeVisible()
    await page.getByRole('button',{name:'Close value',exact:true}).click()
    await page.getByRole('button',{name:'More result actions'}).click()
    const download=page.waitForEvent('download')
    await page.getByRole('menuitem',{name:'Export CSV bundle'}).click()
    const saved=await download;expect(saved.suggestedFilename()).toContain('-s1.zip')
    await page.screenshot({path:'test-results/durable-review-desktop.png',fullPage:true})
    await page.setViewportSize({width:375,height:812})
    const rail=await page.getByRole('complementary',{name:'Evidence, schema and results'}).boundingBox()
    const workspace=await page.getByRole('region',{name:'Source Document',exact:true}).boundingBox()
    expect(rail!.x).toBeGreaterThanOrEqual(workspace!.x)
    expect(rail!.width).toBeLessThanOrEqual(workspace!.width)
    await page.screenshot({path:'test-results/durable-review-mobile.png',fullPage:true})
    const otherContext=await browser.newContext(),other=await otherContext.newPage()
    try {
      await loginResearcher(other,randomUUID())
      expect((await other.request.get(`/api/extractions/${id}/durable`)).status()).toBe(404)
      expect((await other.request.get(`/api/extractions/${id}/durable/source`)).status()).toBe(404)
      const denied=await other.request.post(`/api/extractions/${id}/durable/values/title`,{data:{snapshotVersion:1,expectedRevision:1,action:'EDITED',value:'Another owner' ,included:true,evidence:[]},headers:{Origin:new URL(fixture.url,other.url()).origin}})
      expect(denied.status()).toBe(404)
    } finally {await otherContext.close()}
    const ownState=await page.request.get(`/api/extractions/${id}/durable`)
    expect((await ownState.json()).extractionId).toBe(id)
    expect((await pool.query('SELECT count(*)::int AS n FROM extraction_runtime.correction WHERE "extractionId"=$1',[id])).rows[0].n).toBe(1)
    await page.getByRole('button',{name:'Finalize this snapshot'}).click()
    await expect(page.getByRole('alert')).toContainText('Review each saved value')
    await page.getByRole('button',{name:/To check year 2026/}).click()
    await page.getByRole('button',{name:'Approve',exact:true}).click()
    await expect(page.getByRole('button',{name:/Approved year 2026/})).toBeVisible()
    await page.getByRole('button',{name:'Finalize this snapshot'}).click()
    await expect(page.getByText('Finalized review · results 1 · decisions 2.',{exact:false})).toBeVisible()
    await page.reload()
    await page.locator('#rail-tab-results').click()
    await expect(page.getByText('Finalized review · results 1 · decisions 2.',{exact:false})).toBeVisible()
    await page.getByRole('button',{name:'Stop',exact:true}).click()
    await expect(page.getByRole('button',{name:'Resume',exact:true})).toHaveCount(0)
    const stopped=await (await page.request.get(`/api/extractions/${id}/durable`)).json()
    expect(stopped.status).toBe('STOPPED')
    expect((await page.request.post(`/api/extractions/${id}/durable/control`,{data:{id:randomUUID(),expectedVersion:stopped.controlVersion,action:'resume'},headers:{Origin:new URL(page.url()).origin}})).status()).toBe(409)
    await page.getByRole('button',{name:'All',exact:true}).click()
    await expect(page.getByText('Corrected without Evidence',{exact:true})).toBeVisible()
    await page.getByRole('button',{name:'More result actions'}).click()
    const workbook=page.waitForEvent('download')
    await page.getByRole('menuitem',{name:'Export XLSX'}).click()
    expect((await workbook).suggestedFilename()).toContain('-s1.xlsx')
  } finally {await fixture.close()}
})

test('whole typed edits preserve siblings and pending input adoption preserves producing history',async({page})=> {
  const fixture=await prepareInteractiveDocument(page,{hasKey:false})
  const nodes=[{id:'title',name:'title',type:'string' as const},{id:'flag',name:'flag',type:'boolean' as const},
    {id:'work',name:'work',type:'object' as const,children:[{id:'name',name:'name',type:'string' as const},{id:'included',name:'included',type:'boolean' as const}]},
    {id:'names',name:'names',type:'array' as const,itemType:'string' as const}]
  const original={name:'Book',included:false}
  try {
    const {id}=await savedExtraction(fixture,nodes,['Title',false,original,['Ada','Bob']])
    await fixture.open();await page.locator('#rail-tab-results').click()
    await page.getByRole('button',{name:/To check title Title/}).click()
    await page.getByRole('button',{name:'Edit',exact:true}).click()
    await page.getByRole('textbox',{name:'Reviewed value'}).fill('  ')
    await page.getByRole('button',{name:'Save edit',exact:true}).click()
    await expect(page.getByRole('alert')).toContainText('Enter a value.')
    expect((await (await page.request.get(`/api/extractions/${id}/durable/values/title`)).json()).values[0].correction).toBeNull()
    await page.getByRole('button',{name:'Cancel',exact:true}).click()
    await page.getByRole('button',{name:'Close value',exact:true}).click()
    await page.getByRole('button',{name:/To check work/}).click()
    await page.getByRole('button',{name:'Edit',exact:true}).click()
    await page.getByRole('textbox',{name:'Reviewed value'}).fill('{"name":"Corrected book","included":false}')
    await page.getByRole('button',{name:'Save edit',exact:true}).click()
    const values=await (await page.request.get(`/api/extractions/${id}/durable/values`)).json()
    expect(values.values.find((v:{id:string})=>v.id==='work').correction.decision.value).toEqual({name:'Corrected book',included:false})
    await page.getByRole('button',{name:/To check flag false/}).click()
    await page.getByRole('button',{name:'Edit',exact:true}).click()
    await page.getByRole('combobox',{name:'Reviewed value'}).selectOption('true')
    await page.getByRole('button',{name:'Save edit',exact:true}).click()
    await page.getByRole('button',{name:/To check names/}).click()
    await page.getByRole('button',{name:'Edit',exact:true}).click()
    await page.getByRole('textbox',{name:'Reviewed value'}).fill('[1]')
    await page.getByRole('button',{name:'Save edit',exact:true}).click()
    await expect(page.getByRole('alert')).toContainText('does not fit its producing field')
    await page.getByRole('textbox',{name:'Reviewed value'}).fill('["Ada","Bea"]')
    await page.getByRole('button',{name:'Save edit',exact:true}).click()
    await page.getByRole('button',{name:'Change inputs',exact:true}).click()
    await page.getByRole('button',{name:'Save pending inputs',exact:true}).click()
    await expect(page.getByText('Guidance for pending inputs',{exact:false})).toBeVisible()
    await expect(page.getByRole('button',{name:'Resume',exact:true})).toBeDisabled()
    await page.getByRole('button',{name:'Apply changes',exact:true}).click()
    await expect(page.getByText('Changes pending — apply or discard, then resume.',{exact:true})).toHaveCount(0)
    const head=await (await page.request.get(`/api/extractions/${id}/durable`)).json()
    const retained=await (await page.request.get(`/api/extractions/${id}/durable/values`)).json()
    const work=retained.values.find((v:{id:string})=>v.id==='work')
    expect(head.extractionId).toBe(id)
    expect(work.selectionId).not.toBe(head.selection.id)
    expect(work.modelValue).toEqual(original)
    expect(work.correction.decision.value).toEqual({name:'Corrected book',included:false})
    expect(retained.values.find((v:{id:string})=>v.id==='flag').correction.decision.value).toBe(true)
    expect(retained.values.find((v:{id:string})=>v.id==='names').correction.decision.value).toEqual(['Ada','Bea'])
    await page.getByRole('button',{name:'All',exact:true}).click()
    await page.getByRole('button',{name:/Edited work/}).click()
    await expect(page.getByText(`Producing schema ${work.schemaRevisionId.slice(0,8)}`,{exact:false})).toBeVisible()
    await page.screenshot({path:'test-results/durable-composite-review.png',fullPage:true})
  } finally {await fixture.close()}
})

test('an off-page ungrounded value keeps its source, optional Evidence and target-specific guidance',async({page})=> {
  const fixture=await prepareInteractiveDocument(page,{hasKey:false})
  const nodes=[{id:'title',name:'title',type:'string' as const}]
  const valueId='record-505:title'
  try {
    const {id}=await savedExtraction(fixture,nodes,[],'FAILED',{records:Array.from({length:506},(_,index)=>[`Saved title ${index}`])})
    const latestSource=randomUUID()
    await pool.query(`INSERT INTO public."sourceRepresentationRevision" (id,"sourceDocumentId","revisionNumber","artifactReference","artifactSha256","contractVersion","preprocessId","parserName","parserVersion")
      SELECT $1,"sourceDocumentId",2,"artifactReference","artifactSha256","contractVersion",$2,'fixture','2' FROM public."sourceRepresentationRevision" WHERE id=$3`,
      [latestSource,`kei-exp:e2e-${latestSource}:g2`,fixture.sourceRepresentationRevisionId])
    await page.goto(`${fixture.url}?extractionId=${id}&value=${encodeURIComponent(valueId)}`)
    await page.locator('#rail-tab-results').click()
    const review=page.getByRole('region',{name:'Review title',exact:true})
    await expect(review).toContainText('Saved title 505')
    expect((await (await page.request.get(`/api/extractions/${id}/durable`)).json()).sourceRevisionId).toBe(fixture.sourceRepresentationRevisionId)
    const source=(await (await page.request.get(`/api/extractions/${id}/durable/source`)).json()).document
    const anchor=source.evidence_index.anchors.find((each:{producer_observations:unknown[]})=>each.producer_observations.length)
    const occurrence=anchor.producer_observations[0].occurrence_id
    await review.getByRole('combobox',{name:'Link correction Evidence from this source'}).selectOption(JSON.stringify([anchor.anchor_id,occurrence]))
    await review.getByRole('button',{name:'Edit',exact:true}).click()
    await review.getByRole('textbox',{name:'Reviewed value'}).fill('Corrected title 505')
    await review.getByRole('button',{name:'Save edit',exact:true}).click()
    const valueUrl=`/api/extractions/${id}/durable/values/${encodeURIComponent(valueId)}`
    await expect.poll(async()=> (await (await page.request.get(valueUrl)).json()).values[0].correction?.decision.value).toBe('Corrected title 505')
    const retained=(await (await page.request.get(valueUrl)).json()).values[0]
    expect(retained.grounding).toBe('ungrounded')
    expect(retained.correction.decision.evidence).toEqual([{anchorId:anchor.anchor_id,occurrenceIds:[occurrence]}])
    await page.reload();await page.locator('#rail-tab-results').click()
    await expect(page.getByRole('button',{name:'Correction Evidence',exact:true})).toBeVisible()
    await page.getByRole('button',{name:'Correction Evidence',exact:true}).click()
    await expect(page.locator('.parsed-evidence-highlight')).toHaveCount(1)
    await page.getByText(/^Project guidance/).click()
    await expect(page.getByText(/compatible for this target/)).toBeVisible()
    await page.getByRole('button',{name:'Exclude from guidance',exact:true}).click()
    await expect(page.getByRole('button',{name:'Include in guidance',exact:true})).toBeVisible()
    await page.getByRole('button',{name:'Include in guidance',exact:true}).click()
    await expect(page.getByRole('button',{name:'Exclude from guidance',exact:true})).toBeVisible()
    const revision=randomUUID()
    await pool.query(`INSERT INTO public."schemaRevision" (id,"extractionSchemaId","revisionNumber",origin,"schemaTree","recordScope")
      SELECT $1,$2,max("revisionNumber")+1,'RESEARCHER_EDIT',$3,'records' FROM public."schemaRevision" WHERE "extractionSchemaId"=$2`,
      [revision,fixture.extractionSchemaId,{recordDescription:'One record.',schemaNodes:[{id:'title',name:'title',type:'number'}]}])
    const head=await (await page.request.get(`/api/extractions/${id}/durable`)).json()
    const pending=await page.request.post(`/api/extractions/${id}/durable/selection`,{headers:{Origin:new URL(page.url()).origin},data:{expectedVersion:head.controlVersion,schemaRevisionId:revision,method:{models:null,settings:{generic:null}}}})
    expect(pending.status()).toBe(200)
    await expect(page.getByText(/1 saved correction is incompatible with the pending schema/)).toBeVisible()
    await page.getByRole('button',{name:'Apply changes',exact:true}).click()
    await page.getByText(/^Project guidance/).click()
    await expect(page.getByText(/1 saved correction is incompatible with this schema/)).toBeVisible()
    const stillSaved=(await (await page.request.get(valueUrl)).json()).values[0]
    expect(stillSaved.modelValue).toBe('Saved title 505')
    expect(stillSaved.correction.decision.value).toBe('Corrected title 505')
    await page.getByRole('button',{name:'More result actions'}).click()
    const downloading=page.waitForEvent('download')
    await page.getByRole('menuitem',{name:'Export CSV bundle'}).click()
    const files=unzipSync(new Uint8Array(await readFile((await (await downloading).path())!)))
    const exported=JSON.parse(strFromU8(files['snapshot.json']))
    expect(exported.values).toHaveLength(506)
    expect(new Set(exported.values.map((value:{id:string})=>value.id)).size).toBe(506)
    expect(exported.values.find((value:{id:string})=>value.id===valueId).correction.decision.value).toBe('Corrected title 505')
    expect(exported.manifest.historyCapturedAt).toBeTruthy()
    expect(exported.manifest.historyScope).toContain('capture time')
    expect(exported.history.selections).toHaveLength(2)
    await page.screenshot({path:'test-results/durable-pinned-source-guidance.png',fullPage:true})
  } finally {await fixture.close()}
})

for(const status of ['PAUSED','FAILED','STOPPED'] as const) {
  test(`a fully ${status.toLowerCase()} batch opens and exports retained members`,async({page})=> {
    const fixture=await prepareInteractiveDocument(page,{hasKey:false})
    try {
      const nodes=[{id:'title',name:'title',type:'string' as const}]
      const first=await savedExtraction(fixture,nodes,['First saved title'],status)
      const documentId=randomUUID(),representationId=randomUUID(),batchId=randomUUID()
      // Distinct valid PDF bytes, while retaining the real parsed-document package.
      const parsed=(await (await page.request.get(`/api/extractions/${first.id}/durable/source`)).json()).document
      const originalPdf=await readFile(new URL('../../../examples/Beretning_Ellekilde_8_13.pdf',import.meta.url))
      const pdf=new Uint8Array([...originalPdf,...new TextEncoder().encode('\n% Durable batch fixture second document\n')])
      const {createHash}=await import('node:crypto')
      const hash=createHash('sha256').update(pdf).digest('hex')
      parsed.document.content_sha256=hash;parsed.document.source.original_filename='second.pdf';parsed.document.source.byte_size=pdf.length
      for(const anchor of parsed.evidence_index.anchors)anchor.content_sha256=hash
      const descriptor=await canonicalPackageStore.save(packCanonicalPackage({pdf,document:parsed,markdown:'# Second batch source\n'}))
      await pool.query(`INSERT INTO public."sourceDocument" (id,"projectContextId","contentSha256","mediaType","originalName") VALUES ($1,$2,$3,'application/pdf','second.pdf')`,[documentId,fixture.projectContextId,hash])
      await pool.query(`INSERT INTO public."sourceRepresentationRevision" (id,"sourceDocumentId","revisionNumber","artifactReference","artifactSha256","contractVersion","preprocessId","parserName","parserVersion")
        VALUES ($1,$2,1,$3,$4,'parsed_document.v2',$5,'fixture','1')`,
        [representationId,documentId,descriptor.artifactReference,descriptor.artifactSha256,`kei-exp:e2e-${representationId}:g1`])
      const second=await savedExtraction({...fixture,sourceDocumentId:documentId,sourceRepresentationRevisionId:representationId},nodes,['Second saved title'],status,{schemaRevisionId:first.schemaRevisionId})
      await pool.query(`INSERT INTO public."batchExtraction" (id,"projectContextId","schemaRevisionId",strategy,"requestedSettings") VALUES ($1,$2,$3,'ARTICLE',$4)`,[batchId,fixture.projectContextId,first.schemaRevisionId,{article:null}])
      await pool.query(`UPDATE public.extraction SET "batchExtractionId"=$1 WHERE id=ANY($2::uuid[])`,[batchId,[first.id,second.id]])
      // Even a direct grid link keeps native typed decisions on member routes.
      await page.goto(`/projects/${fixture.projectContextId}/extractions/${batchId}/review`)
      await expect(page.getByText(`2 ${status.toLowerCase()}`,{exact:true})).toBeVisible()
      await expect(page.getByRole('button',{name:'Review grid',exact:true})).toBeDisabled()
      const members=page.getByRole('list',{name:'Batch Extraction members'})
      await expect(members.getByRole('button')).toHaveCount(2)
      await expect(members.getByRole('button').first()).toBeEnabled()
      await page.getByRole('button',{name:'Export',exact:true}).click()
      const downloading=page.waitForEvent('download')
      await page.getByRole('menuitem',{name:'Export CSV bundle',exact:true}).click()
      const files=unzipSync(new Uint8Array(await readFile((await (await downloading).path())!)))
      const exported=JSON.parse(strFromU8(files['snapshot.json']))
      expect(exported.totalMembers).toBe(2)
      expect(exported.durable).toHaveLength(2)
      expect(exported.durable.every((member:{manifest:{status:string}})=>member.manifest.status===status)).toBe(true)
      expect(exported.durable.flatMap((member:{values:{modelValue:string}[]})=>member.values.map(value=>value.modelValue)).sort()).toEqual(['First saved title','Second saved title'])
      await members.getByRole('button',{name:/second.pdf/}).click()
      await expect(page).toHaveURL(new RegExp(`documents/${documentId}.*extractionId=${second.id}`))
      await page.locator('#rail-tab-results').click()
      await expect(page.getByText('Second saved title',{exact:false})).toBeVisible()
    } finally {await fixture.close()}
  })
}

test('every native lifecycle shows retained review and running keyboard edits keep processing independent',async({page})=> {
  const fixture=await prepareInteractiveDocument(page,{hasKey:false})
  try {
    const nodes=[{id:'title',name:'title',type:'string' as const}]
    const cases=[['QUEUED','RUN'],['RUNNING','RUN'],['RUNNING','PAUSE'],['PAUSED','PAUSE'],['RUNNING','STOP'],['STOPPED','STOP'],['COMPLETED','RUN'],['FAILED','PAUSE']] as const
    let opened=false
    for(const [acknowledgement,intent] of cases) {
      const status=intent==='STOP'&&acknowledgement==='RUNNING'?'STOPPING':intent==='PAUSE'&&acknowledgement==='RUNNING'?'PAUSING':acknowledgement
      const {id}=await savedExtraction(fixture,nodes,[`Retained ${status}`],acknowledgement,{intent})
      const route=`${fixture.url}?extractionId=${id}`
      if(!opened){await page.goto(route);opened=true}
      else await page.evaluate(route=>{window.history.pushState(null,'',route);window.dispatchEvent(new PopStateEvent('popstate'))},route)
      await page.locator('#rail-tab-results').click()
      const rail=page.getByRole('complementary',{name:'Evidence, schema and results'})
      await expect(rail.getByText(status.charAt(0)+status.slice(1).toLowerCase(),{exact:true})).toBeVisible()
      await expect(rail.getByText(`Retained ${status}`,{exact:false})).toBeVisible()
      await rail.getByRole('button',{name:`To check title Retained ${status}`}).click()
      await expect(rail.getByRole('button',{name:'Edit',exact:true})).toBeEnabled()
      expect((await (await page.request.get(`/api/extractions/${id}/durable`)).json()).controlVersion).toBe(0)
      if(status!=='RUNNING'||intent!=='RUN')continue
      await rail.getByRole('button',{name:'Review from here',exact:true}).click()
      for(const name of ['More result actions','Run details']) {
        const overlay=rail.getByRole('button',{name});await overlay.click()
        const target=name==='More result actions'?rail.getByRole('menuitem',{name:'Export XLSX'}):overlay
        await target.focus()
        for(const key of ['a','r','e','j','k','z'])await page.keyboard.press(key)
        expect((await (await page.request.get(`/api/extractions/${id}/durable/values/title`)).json()).values[0].correction).toBeNull()
        await expect(rail.getByRole('textbox',{name:'Reviewed value'})).toHaveCount(0)
        await page.keyboard.press('Escape')
        await expect(overlay).toHaveAttribute('aria-expanded','false')
        await expect(rail.getByRole('heading',{name:'Retained RUNNING',exact:true})).toBeFocused()
      }
      await page.keyboard.press('z')
      expect((await (await page.request.get(`/api/extractions/${id}/durable/values/title`)).json()).values[0].correction).toBeNull()
      await page.keyboard.press('e')
      await rail.getByRole('textbox',{name:'Reviewed value'}).press('Escape')
      await expect(rail.getByRole('heading',{name:'Retained RUNNING',exact:true})).toBeFocused()
      await page.keyboard.press('e')
      await rail.getByRole('button',{name:/^Save.*next$/i}).focus()
      await page.keyboard.press('Escape')
      await expect(rail.getByRole('heading',{name:'Retained RUNNING',exact:true})).toBeFocused()
      await page.keyboard.press('e')
      await rail.getByRole('textbox',{name:'Reviewed value'}).fill('Running corrected title')
      await rail.getByRole('button',{name:/^Save.*next$/i}).click()
      await expect.poll(async()=> (await (await page.request.get(`/api/extractions/${id}/durable/values/title`)).json()).values[0].correction?.decision.value).toBe('Running corrected title')
      await page.locator('#rail-tab-schema').click()
      await page.keyboard.press('a');await page.keyboard.press('r')
      const head=await (await page.request.get(`/api/extractions/${id}/durable`)).json()
      expect(head.status).toBe('RUNNING');expect(head.controlVersion).toBe(0)
      const decision=(await (await page.request.get(`/api/extractions/${id}/durable/values/title`)).json()).values[0].correction
      expect(decision.revision).toBe(1);expect(decision.decision.action).toBe('EDITED')
    }
  } finally {await fixture.close()}
})

test('concurrent whole-value drafts show a conflict and Undo restores the previous saved correction',async({page})=>{
  const fixture=await prepareInteractiveDocument(page,{hasKey:false})
  const nodes=[{id:'title',name:'title',type:'string' as const},{id:'work',name:'work',type:'object' as const,children:[{id:'a',name:'a',type:'integer' as const},{id:'b',name:'b',type:'integer' as const}]}]
  let second:Page|undefined
  try {
    const {id}=await savedExtraction(fixture,nodes,['Fixture title',{a:1,b:2}])
    await fixture.open();await page.locator('#rail-tab-results').click()
    second=await page.context().newPage();await second.goto(page.url());await second.locator('#rail-tab-results').click()
    for(const view of [page,second]) {
      await view.getByRole('button',{name:/To check work/}).click()
      await view.getByRole('button',{name:'Edit',exact:true}).click()
    }
    const read=async()=>(await (await page.request.get(`/api/extractions/${id}/durable/values/work`)).json()).values[0].correction
    await page.getByRole('textbox',{name:'Reviewed value'}).fill('{"a":10,"b":2}')
    await page.getByRole('button',{name:'Save edit',exact:true}).click()
    await expect.poll(async()=>(await read())?.revision).toBe(1)
    await second.getByRole('textbox',{name:'Reviewed value'}).fill('{"a":1,"b":20}')
    await second.getByRole('button',{name:'Save edit',exact:true}).click()
    await expect(second.getByRole('alert')).toContainText('newer correction')
    await expect(second.getByRole('textbox',{name:'Reviewed value'})).toHaveValue('{"a":1,"b":20}')
    await second.getByRole('button',{name:'Reload saved decision · keep my draft'}).click()
    await expect(second.getByRole('region',{name:'Compare saved value and draft'})).toContainText('{"a":10,"b":2}')
    await expect(second.getByRole('textbox',{name:'Reviewed value'})).toHaveValue('{"a":1,"b":20}')
    await second.getByRole('textbox',{name:'Reviewed value'}).fill('{"a":10,"b":20}')
    await second.getByRole('button',{name:'Save edit',exact:true}).click()
    await expect.poll(async()=>(await read())?.decision.value).toEqual({a:10,b:20})
    await second.getByRole('button',{name:'All',exact:true}).click()
    await second.getByRole('button',{name:/Edited work/}).click()
    await second.getByRole('button',{name:'Undo',exact:true}).click()
    await expect.poll(async()=>(await read())?.decision.value).toEqual({a:10,b:2})
    expect((await read()).revision).toBe(3)
    await second.getByRole('button',{name:/Edited work/}).click()
    await second.getByRole('button',{name:'Mark pending',exact:true}).click()
    await expect.poll(async()=>(await read())?.decision.action).toBe('PENDING')
    const history=await (await page.request.get(`/api/extractions/${id}/durable/history`)).json()
    expect(history.corrections.map((correction:{revision:number})=>correction.revision)).toEqual([1,2,3,4])
    await second.getByText(/^Project guidance/).click()
    const historical=await second.getByRole('link',{name:'Open saved correction and review · revision 3'}).getAttribute('href')
    await page.goto(historical!);await page.locator('#rail-tab-results').click()
    await expect(page.getByRole('region',{name:'Review work'})).toContainText('{"a":10,"b":2}')
    await expect(page.getByText(/Your open review stays/)).toHaveCount(0)
    await expect(page).toHaveURL(/snapshotVersion=1&feedbackVersion=3/)
  } finally {await second?.close();await fixture.close()}
})
