import { expect,test,type Page } from '@playwright/test'
import { createHash,randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { unzipSync, strFromU8 } from 'fflate'
import { canonicalPackageStore,pool,withPoolClientTransaction } from 'db'
import { packCanonicalPackage } from '../../../packages/db/src/artifact-store.js'
import { initializeDurableExtraction } from 'extraction/durable'
import type { DurableValue } from 'extraction/durable-contract'
import { decodeParsedDocument } from 'extraction/parsed-document'
import { prepareInteractiveDocument,INTERACTIVE_SCHEMA_NODES } from './interactiveStack.js'
import { E2E_ORIGIN,loginResearcher } from './auth.js'
import { savedBatchSource,savedExtraction } from './durableFixtures.js'

test.beforeEach(({page})=> {
  page.on('pageerror',error=>console.error('durable browser error:',error.message))
  page.on('requestfailed',request=>console.error('durable browser request failed:',request.url(),request.failure()?.errorText))
})

test('every durable API rejects unauthenticated and foreign owners, wrong origins and oversized writes',async({page,browser})=>{
  const fixture=await prepareInteractiveDocument(page,{hasKey:false})
  const otherContext=await browser.newContext(),anonymous=await browser.newContext()
  try {
    const {id,schemaRevisionId}=await savedExtraction(fixture,[{id:'title',name:'title',type:'string'}],['Private value'])
    const state=await (await page.request.get(`/api/extractions/${id}/durable`)).json()
    const root=`/api/extractions/${id}/durable`,feedback=`/api/project-contexts/${fixture.projectContextId}/feedback`
    const reads=[root,`${root}/source`,`${root}/history`,`${root}/values`,`${root}/values/title`,feedback,`${feedback}?target=${id}`]
    const writes:[string,object][]=[
      [`${root}/control`,{id:randomUUID(),expectedVersion:state.controlVersion,action:'pause'}],
      [`${root}/selection`,{expectedVersion:state.controlVersion,schemaRevisionId,method:{models:null,settings:{article:null}}}],
      [`${root}/adopt`,{expectedVersion:state.controlVersion,selectionId:state.selection.id,reprocessValueIds:[]}],
      [`${root}/values/title`,{expectedRevision:0,snapshotVersion:1,action:'EDITED',value:'Refused write',included:true,evidence:[]}],
      [`${root}/finalize`,{snapshotVersion:1,feedbackVersion:0}],
      [feedback,{id:randomUUID(),expectedRevision:1,included:false}],
    ]
    const other=await otherContext.newPage()
    await loginResearcher(other,randomUUID())
    // Refused POSTs need not consume their bodies. Use a fresh connection for
    // each rejection rather than reusing a socket closed by the server.
    const origin={Origin:E2E_ORIGIN,Connection:'close'}
    for(const path of reads) {
      expect((await anonymous.request.get(new URL(path,E2E_ORIGIN).href)).status(),path).toBe(401)
      expect((await other.request.get(path)).status(),path).toBe(404)
    }
    for(const [path,data] of writes) {
      expect((await anonymous.request.post(new URL(path,E2E_ORIGIN).href,{headers:origin,data})).status(),path).toBe(401)
      expect((await other.request.post(path,{headers:origin,data})).status(),path).toBe(404)
      expect((await page.request.post(path,{headers:{...origin,Origin:'https://foreign.invalid'},data})).status(),path).toBe(403)
      expect((await page.request.post(path,{headers:{...origin,'Content-Type':'application/json'},data:JSON.stringify({payload:'x'.repeat(1024*1024)})})).status(),path).toBe(413)
    }
    expect((await page.request.post(`${root}/values/title`,{headers:origin,data:{expectedRevision:0,snapshotVersion:1,action:'EDITED',value:'Refused Evidence',included:true,evidence:[{anchorId:'foreign-anchor',occurrenceIds:['foreign-occurrence']}]}})).status()).toBe(422)
    const unrelated=await page.request.post('/api/project-contexts',{headers:origin,data:{name:'Unrelated guidance target'}})
    expect(unrelated.status()).toBe(201)
    const otherProject=(await unrelated.json()).projectContext.projectContextId
    expect((await page.request.get(`/api/project-contexts/${otherProject}/feedback?target=${id}`)).status()).toBe(404)
    expect((await (await page.request.get(root)).json()).controlVersion).toBe(state.controlVersion)
    expect((await (await page.request.get(`${root}/values/title`)).json()).values[0].correction).toBeNull()
  } finally {await otherContext.close();await anonymous.close();await fixture.close()}
})

// This fixture publishes retained work directly into its
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
    await page.getByRole('button',{name:'Finalize results 1 · decisions 1',exact:true}).first().click()
    await expect(page.getByRole('alert')).toContainText('Review each saved value')
    await page.getByRole('button',{name:/To check year 2026/}).click()
    await page.getByRole('button',{name:'Approve',exact:true}).click()
    await expect(page.getByRole('button',{name:/Approved year 2026/})).toBeVisible()
    await page.getByRole('button',{name:'Finalize results 1 · decisions 2',exact:true}).first().click()
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
    const savedValue=async(valueId:string)=>(await (await page.request.get(`/api/extractions/${id}/durable/values/${valueId}`)).json()).values[0].correction?.decision.value
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
    await expect.poll(()=>savedValue('work')).toEqual({name:'Corrected book',included:false})
    await page.getByRole('button',{name:/To check flag false/}).click()
    await page.getByRole('button',{name:'Edit',exact:true}).click()
    await page.getByRole('combobox',{name:'Reviewed value'}).selectOption('true')
    await page.getByRole('button',{name:'Save edit',exact:true}).click()
    await expect.poll(()=>savedValue('flag')).toBe(true)
    await page.getByRole('button',{name:/To check names/}).click()
    await page.getByRole('button',{name:'Edit',exact:true}).click()
    await page.getByRole('textbox',{name:'Reviewed value'}).fill('[1]')
    await page.getByRole('button',{name:'Save edit',exact:true}).click()
    await expect(page.getByRole('alert')).toContainText('does not fit its producing field')
    await page.getByRole('textbox',{name:'Reviewed value'}).fill('["Ada","Bea"]')
    await page.getByRole('button',{name:'Save edit',exact:true}).click()
    await expect.poll(()=>savedValue('names')).toEqual(['Ada','Bea'])
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

test('One by one waits for its pinned source before navigating retained Model Evidence',async({page})=>{
  const fixture=await prepareInteractiveDocument(page,{hasKey:false})
  const release=Promise.withResolvers<void>()
  let received=false
  try {
    const source=decodeParsedDocument(await (await page.request.get(`/api/project-contexts/${fixture.projectContextId}/source-representations/${fixture.sourceRepresentationRevisionId}/source`)).json())
    const anchor=source.evidence_index.anchors[0]!,occurrence=anchor.producer_observations[0]!
    const {id}=await savedExtraction(fixture,[{id:'title',name:'title',type:'string'}],['Grav 8'],'PAUSED',
      {modelEvidence:{title:[{anchorId:anchor.anchor_id,occurrenceIds:[occurrence.occurrence_id],producer:{path:['records',0,'title'],
        segment:'p1_s0',page:1,bbox_pt:[36,36,100,54],verbatim:true,hits:1,linked_by:'lexical',precision:'segment'}}]}})
    // Direct reopen already chooses the producing source. Hold its real parsed
    // document request while the retained values and PDF become available.
    await page.route(`**/api/project-contexts/${fixture.projectContextId}/source-representations/${fixture.sourceRepresentationRevisionId}/source?*`,async route=>{
      const response=await route.fetch()
      received=true;await release.promise
      await route.fulfill({response})
    })
    await page.goto(`${fixture.url}?extractionId=${id}`)
    await page.locator('#rail-tab-results').click()
    await expect.poll(()=>received).toBe(true)
    await expect(page.getByText('/ 6',{exact:true})).toBeVisible()
    await page.getByRole('button',{name:'One by one',exact:true}).click()
    await expect(page.getByRole('heading',{name:'Grav 8',exact:true})).toBeFocused()
    await expect(page.locator('.parsed-evidence-focus')).toHaveCount(0)
    release.resolve()
    await expect(page.locator('.parsed-evidence-focus')).toHaveCount(1)
    await expect(page.locator('.parsed-evidence-focus')).toHaveAttribute('data-occurrence-id',occurrence.occurrence_id)
  } finally {release.resolve();await fixture.close()}
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
      const batchId=randomUUID()
      const parsed=decodeParsedDocument((await (await page.request.get(`/api/extractions/${first.id}/durable/source`)).json()).document)
      const secondSource=await savedBatchSource(fixture,parsed,'second.pdf')
      const second=await savedExtraction(secondSource,nodes,['Second saved title'],status,{schemaRevisionId:first.schemaRevisionId})
      await pool.query(`INSERT INTO public."batchExtraction" (id,"projectContextId","schemaRevisionId",strategy,"requestedSettings") VALUES ($1,$2,$3,'ARTICLE',$4)`,[batchId,fixture.projectContextId,first.schemaRevisionId,{article:null}])
      await pool.query(`UPDATE public.extraction SET "batchExtractionId"=$1 WHERE id=ANY($2::uuid[])`,[batchId,[first.id,second.id]])
      await page.goto(`/projects/${fixture.projectContextId}/extractions/${batchId}`)
      await expect(page.getByText(`2 ${status.toLowerCase()}`,{exact:true})).toBeVisible()
      await expect(page.getByRole('button',{name:'Review grid',exact:true})).toHaveCount(0)
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
      await expect(page).toHaveURL(new RegExp(`documents/${secondSource.sourceDocumentId}.*extractionId=${second.id}`))
      await page.locator('#rail-tab-results').click()
      await expect(page.getByText('Second saved title',{exact:false})).toBeVisible()
    } finally {await fixture.close()}
  })
}

test('a mixed retained batch counts an empty failed member and exports its fixed cut',async({page})=>{
  const fixture=await prepareInteractiveDocument(page,{hasKey:false})
  try {
    const nodes=[{id:'title',name:'title',type:'string' as const}],batchId=randomUUID()
    const first=await savedExtraction(fixture,nodes,['Paused retained title'])
    const source=decodeParsedDocument((await (await page.request.get(`/api/extractions/${first.id}/durable/source`)).json()).document)
    const emptySource=await savedBatchSource(fixture,source,'empty.pdf'),stoppedSource=await savedBatchSource(fixture,source,'stopped.pdf')
    const empty=await savedExtraction(emptySource,nodes,[],'FAILED',{schemaRevisionId:first.schemaRevisionId,empty:true})
    const stopped=await savedExtraction(stoppedSource,nodes,['Stopped retained title'],'STOPPED',{schemaRevisionId:first.schemaRevisionId})
    await pool.query(`INSERT INTO public."batchExtraction" (id,"projectContextId","schemaRevisionId",strategy,"requestedSettings") VALUES ($1,$2,$3,'ARTICLE',$4)`,[batchId,fixture.projectContextId,first.schemaRevisionId,{article:null}])
    await pool.query(`UPDATE public.extraction SET "batchExtractionId"=$1 WHERE id=ANY($2::uuid[])`,[batchId,[first.id,empty.id,stopped.id]])
    await page.goto(`/projects/${fixture.projectContextId}/extractions/${batchId}`)
    const summary=page.getByText(/1 paused/)
    await expect(summary).toContainText('1 failed');await expect(summary).toContainText('1 stopped')
    const members=page.getByRole('list',{name:'Batch Extraction members'})
    await expect(members.getByRole('button')).toHaveCount(3)
    await expect(page.getByRole('button',{name:'Review grid',exact:true})).toHaveCount(0)
    await page.getByRole('button',{name:'Export',exact:true}).click()
    const downloading=page.waitForEvent('download')
    await page.getByRole('menuitem',{name:'Export CSV bundle',exact:true}).click()
    const files=unzipSync(new Uint8Array(await readFile((await (await downloading).path())!)))
    const exported=JSON.parse(strFromU8(files['snapshot.json']))
    expect(exported.totalMembers).toBe(3);expect(exported.durable).toHaveLength(3)
    expect(exported.durable.map((member:{manifest:{status:string};values:unknown[]})=>[member.manifest.status,member.values.length]).sort()).toEqual([['FAILED',0],['PAUSED',1],['STOPPED',1]])
    await members.getByRole('button',{name:/empty.pdf/}).click()
    await expect(page).toHaveURL(new RegExp(`documents/${emptySource.sourceDocumentId}.*extractionId=${empty.id}`))
    await page.locator('#rail-tab-results').click()
    const rail=page.getByRole('complementary',{name:'Evidence, schema and results'})
    await expect(rail.getByText('Failed',{exact:true})).toBeVisible()
    await expect(rail.getByRole('button',{name:'One by one',exact:true})).toBeDisabled()
    expect((await (await page.request.get(`/api/extractions/${empty.id}/durable/values`)).json()).values).toEqual([])
    expect((await (await page.request.get(`/api/extractions/${empty.id}/durable`)).json()).controlVersion).toBe(0)
  } finally {await fixture.close()}
})

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
      if(status!=='RUNNING'||intent!=='RUN') {
        await rail.getByRole('button',{name:'Edit',exact:true}).click()
        await rail.getByRole('textbox',{name:'Reviewed value'}).fill(`Corrected ${status}`)
        await rail.getByRole('button',{name:'Save edit',exact:true}).click()
        await expect.poll(async()=>(await (await page.request.get(`/api/extractions/${id}/durable/values/title`)).json()).values[0].correction?.decision.value).toBe(`Corrected ${status}`)
        await page.reload();await page.locator('#rail-tab-results').click()
        await rail.getByRole('button',{name:'All',exact:true}).click()
        await expect(rail.getByRole('button',{name:new RegExp(`Edited title Corrected ${status}`)})).toBeVisible()
        expect((await (await page.request.get(`/api/extractions/${id}/durable`)).json()).controlVersion).toBe(0)
        continue
      }
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

test('a delayed correction acknowledgement keeps menu Escape usable without duplicate decisions or finalization',async({page})=>{
  const fixture=await prepareInteractiveDocument(page,{hasKey:false})
  const release=Promise.withResolvers<void>()
  let writes=0
  try {
    const {id}=await savedExtraction(fixture,[{id:'title',name:'title',type:'string'}],['Saved title'])
    await fixture.open();await page.locator('#rail-tab-results').click()
    const url=`/api/extractions/${id}/durable/values/title`
    await page.route(`**${url}`,async route=>{
      if(route.request().method()!=='POST'){await route.continue();return}
      writes++
      const response=await route.fetch()
      await release.promise
      await route.fulfill({response})
    })
    await page.getByRole('button',{name:'One by one',exact:true}).click()
    await page.keyboard.press('a')
    await expect(page.getByText('Saving your decision…')).toBeVisible()
    await page.keyboard.press('r')
    const menu=page.getByRole('button',{name:'More result actions'});await menu.click()
    await page.getByRole('menuitem',{name:'Export XLSX'}).focus()
    await page.keyboard.press('a');await page.keyboard.press('Escape')
    await expect(menu).toHaveAttribute('aria-expanded','false')
    await expect(page.getByRole('heading',{name:'Saved title',exact:true})).toBeFocused()
    expect(writes).toBe(1)
    release.resolve()
    await expect(page.getByText('Saving your decision…')).toHaveCount(0)
    const decision=(await (await page.request.get(url)).json()).values[0].correction
    expect(decision.revision).toBe(1);expect(decision.decision.action).toBe('APPROVED')
    expect((await (await page.request.get(`/api/extractions/${id}/durable/history`)).json()).finalizations).toEqual([])
    expect((await (await page.request.get(`/api/extractions/${id}/durable`)).json()).controlVersion).toBe(0)
  } finally {release.resolve();await fixture.close()}
})

test('shared correction Evidence navigates Markdown UTF-8 spans and stable value links',async({page})=>{
  const fixture=await prepareInteractiveDocument(page,{hasKey:false})
  try {
    const source=await page.request.get(`/api/project-contexts/${fixture.projectContextId}/source-representations/${fixture.sourceRepresentationRevisionId}/source`)
    expect(source.status()).toBe(200)
    const parsed=decodeParsedDocument(await source.json()),prefix='# Grav 8\n\nØrsted: ',passage='NØ-SV',markdown=`${prefix}${passage} orienteret.\n`
    const anchor=parsed.evidence_index.anchors.find(anchor=>anchor.kind==='text'&&anchor.producer_observations.length)
    if(!anchor||anchor.kind!=='text')throw new Error('The Markdown fixture requires text Evidence.')
    anchor.markdown_span={start:Buffer.byteLength(prefix),end:Buffer.byteLength(prefix+passage)}
    const block=parsed.content_stream.find(block=>block.block_id===anchor.block_id)!
    block.markdown_span=anchor.markdown_span
    if('text' in block)block.text=passage
    decodeParsedDocument(parsed)
    const pdf=await page.request.get(`/api/project-contexts/${fixture.projectContextId}/source-representations/${fixture.sourceRepresentationRevisionId}/pdf`)
    const descriptor=await canonicalPackageStore.save(packCanonicalPackage({pdf:await pdf.body(),document:parsed,markdown}))
    await pool.query('UPDATE public."sourceRepresentationRevision" SET "artifactReference"=$2,"artifactSha256"=$3 WHERE id=$1',
      [fixture.sourceRepresentationRevisionId,descriptor.artifactReference,descriptor.artifactSha256])
    const nodes=[{id:'title',name:'title',type:'string' as const},{id:'site',name:'site',type:'string' as const}]
    const {id}=await savedExtraction(fixture,nodes,['Extracted title','Extracted place'])
    await fixture.open();await page.locator('#rail-tab-results').click()
    for(const name of ['title','site']) {
      await page.getByRole('button',{name:new RegExp(`To check ${name} `)}).click()
      await page.getByRole('combobox',{name:'Link correction Evidence from this source'}).selectOption(JSON.stringify([anchor.anchor_id,anchor.producer_observations[0].occurrence_id]))
      await page.getByRole('button',{name:'Edit',exact:true}).click()
      await page.getByRole('textbox',{name:'Reviewed value'}).fill(`Corrected ${name}`)
      await page.getByRole('button',{name:'Save edit',exact:true}).click()
      await expect.poll(async()=>(await (await page.request.get(`/api/extractions/${id}/durable/values/${name}`)).json()).values[0].correction?.decision.value).toBe(`Corrected ${name}`)
    }
    await page.getByRole('group',{name:'Document view'}).getByRole('button',{name:'Markdown',exact:true}).click()
    const view=page.getByLabel('Parsed Markdown'),mark=view.getByRole('button')
    await expect(mark).toHaveCount(1)
    await expect(mark).toHaveText(passage)
    await expect(mark).toHaveAccessibleName(/title: Corrected title.*site: Corrected site/)
    await mark.click()
    const popover=page.getByRole('dialog',{name:'Values in this passage'})
    await expect(popover).toBeVisible()
    await popover.getByRole('button',{name:'site · Corrected site'}).click()
    await expect(page.getByRole('region',{name:'Review site',exact:true})).toContainText('Corrected site')
    await expect(mark).toHaveAttribute('aria-current','true')
    await page.goto(`${fixture.url}?extractionId=${id}&value=site`)
    await page.locator('#rail-tab-results').click()
    await expect(page.getByRole('region',{name:'Review site',exact:true})).toContainText('Corrected site')
    await page.getByRole('group',{name:'Document view'}).getByRole('button',{name:'Markdown',exact:true}).click()
    await expect(page.getByLabel('Parsed Markdown').getByRole('button')).toHaveText(passage)
    await expect(page.getByRole('button',{name:'Correction Evidence',exact:true})).toBeVisible()
    await expect(page.getByRole('button',{name:/Model Evidence/})).toHaveCount(0)
  } finally {await fixture.close()}
})

test('retained Catalog review fits actual 344px and 264px rails and a narrow viewport',async({page},testInfo)=>{
  const fixture=await prepareInteractiveDocument(page,{hasKey:false})
  try {
    await savedExtraction(fixture,[{id:'title',name:'title',type:'string'},{id:'flag',name:'flag',type:'boolean'}],[],
      'FAILED',{records:[['A retained record with a deliberately long source title',false],['Another retained record',true]]})
    await page.setViewportSize({width:1280,height:720})
    await fixture.open();await page.locator('#rail-tab-results').click()
    const rail=page.getByRole('complementary',{name:'Evidence, schema and results'})
    const panel=page.getByRole('tabpanel',{name:/Results/})
    const assertGeometry=async()=>{
      expect(await panel.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true)
      const bounds=(await rail.boundingBox())!
      for(const name of ['Retry','Stop','Change inputs']) {
        const button=rail.getByRole('button',{name,exact:true});await expect(button).toBeVisible()
        const box=(await button.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(bounds.x)
        expect(box.x+box.width).toBeLessThanOrEqual(bounds.x+bounds.width+1)
      }
    }
    for(const width of [344,264]) {
      const current=(await rail.boundingBox())!.width
      const handle=(await page.locator('[title="Drag to resize"]:not([role="separator"])').boundingBox())!
      const x=handle.x+handle.width/2,y=handle.y+handle.height/2
      await page.mouse.move(x,y);await page.mouse.down()
      await page.mouse.move(x+current-width,y,{steps:4});await page.mouse.up()
      await expect.poll(async()=>(await rail.boundingBox())!.width).toBe(width)
      if(width===344) {
        await expect(panel.getByRole('group',{name:'Show values'})).toBeVisible()
        await expect(panel.getByRole('combobox',{name:'Show'})).toBeHidden()
      } else {
        await expect(panel.getByRole('group',{name:'Show values'})).toBeHidden()
        await expect(panel.getByRole('combobox',{name:'Show'})).toBeVisible()
      }
      await assertGeometry()
      await page.screenshot({path:testInfo.outputPath(`durable-rail-${width}.png`)})
    }
    await rail.getByRole('button',{name:/To check title A retained record/}).click()
    await rail.getByRole('button',{name:'Review from here',exact:true}).click()
    await page.keyboard.press('e')
    await expect(rail.getByRole('textbox',{name:'Reviewed value'})).toBeVisible()
    await assertGeometry()
    await page.screenshot({path:testInfo.outputPath('durable-rail-edit-264.png')})
    await page.setViewportSize({width:375,height:812})
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true)
    await assertGeometry()
    await page.screenshot({path:testInfo.outputPath('durable-rail-mobile.png')})
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

/** Another producer publication in this runner's owned disposable database. */
async function appendSavedTitle(extractionId:string,title:string) {
  await withPoolClientTransaction(async(_tx,client)=> {
    const head=(await client.query<{snapshotVersion:number;selectionId:string}>('SELECT * FROM extraction_runtime.head WHERE id=$1 FOR UPDATE',[extractionId])).rows[0]
    const previous=(await client.query<{values:DurableValue[];coverage:unknown}>('SELECT values,coverage FROM extraction_runtime.snapshot WHERE "extractionId"=$1 AND version=$2',[extractionId,head.snapshotVersion])).rows[0]
    const values=previous.values.map(value=>({...value,modelValue:title})),serialized=JSON.stringify(values)
    await client.query(`INSERT INTO extraction_runtime.snapshot (id,"extractionId",version,"selectionId",digest,values,coverage) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(),extractionId,head.snapshotVersion+1,head.selectionId,createHash('sha256').update(serialized).digest('hex'),serialized,previous.coverage])
    await client.query('UPDATE extraction_runtime.head SET "snapshotVersion"="snapshotVersion"+1 WHERE id=$1',[extractionId])
  })
}

for(const source of ['same source','new source revision'] as const) {
  test(`Latest reviewed opens its finalized pair after later work on the ${source}`,async({page})=> {
    const fixture=await prepareInteractiveDocument(page,{hasKey:false})
    try {
      const nodes=[{id:'title',name:'title',type:'string' as const}]
      const reviewed=await savedExtraction(fixture,nodes,['Finalized title'])
      const root=`/api/extractions/${reviewed.id}/durable`,headers={Origin:E2E_ORIGIN}
      const correction=await page.request.post(`${root}/values/title`,{headers,data:{expectedRevision:0,snapshotVersion:1,action:'APPROVED'}})
      expect(correction.ok(),await correction.text()).toBe(true)
      const finalized=await page.request.post(`${root}/finalize`,{headers,data:{snapshotVersion:1,feedbackVersion:1}})
      expect(finalized.ok(),await finalized.text()).toBe(true)
      await appendSavedTitle(reviewed.id,'Later unfinalized title')
      let currentFixture=fixture
      if(source==='new source revision') {
        const nextRevision=randomUUID()
        await pool.query(`INSERT INTO public."sourceRepresentationRevision" (id,"sourceDocumentId","revisionNumber","artifactReference","artifactSha256","contractVersion","preprocessId","parserName","parserVersion")
          SELECT $1,"sourceDocumentId",2,"artifactReference","artifactSha256","contractVersion",$2,'fixture','2'
          FROM public."sourceRepresentationRevision" WHERE id=$3`,[nextRevision,`kei-exp:e2e-${nextRevision}:g1`,fixture.sourceRepresentationRevisionId])
        currentFixture={...fixture,sourceRepresentationRevisionId:nextRevision}
      }
      const current=await savedExtraction(currentFixture,nodes,['Current attempt title'],'PAUSED',{schemaRevisionId:reviewed.schemaRevisionId})
      await fixture.open();await page.locator('#rail-tab-results').click()
      await expect(page.getByText('Current attempt title',{exact:true})).toBeVisible()
      if(source==='same source')await page.getByRole('combobox',{name:'Extraction snapshot'}).selectOption(reviewed.id)
      else {
        await page.getByRole('button',{name:'Open latest reviewed',exact:true}).click()
        await expect(page).toHaveURL(new RegExp(`extractionId=${reviewed.id}&snapshotVersion=1&feedbackVersion=1`))
        await page.locator('#rail-tab-results').click()
      }
      await expect(page.getByText('Finalized review · results 1 · decisions 1. Later work and decisions remain separate.',{exact:true})).toBeVisible()
      await expect(page.getByText('Newer saved results 2 exist.',{exact:false})).toBeVisible()
      await page.getByRole('button',{name:'All',exact:true}).click()
      await expect(page.getByText('Finalized title',{exact:true})).toBeVisible()
      await expect(page.getByText('Later unfinalized title',{exact:true})).toHaveCount(0)
      expect((await (await page.request.get(`${root}/values`)).json()).snapshotVersion).toBe(2)
      expect((await (await page.request.get(`/api/extractions/${current.id}/durable/values`)).json()).values[0].modelValue).toBe('Current attempt title')
      if(source==='new source revision') {
        await page.reload();await page.locator('#rail-tab-results').click()
        await expect(page.getByText('Finalized review · results 1 · decisions 1. Later work and decisions remain separate.',{exact:true})).toBeVisible()
      }
    } finally {await fixture.close()}
  })
}

test('a late post-save page response keeps the newer field and its unsaved browser draft',async({page})=> {
  const fixture=await prepareInteractiveDocument(page,{hasKey:false})
  const held=Promise.withResolvers<void>(),requested=Promise.withResolvers<void>()
  try {
    const nodes=[{id:'title',name:'title',type:'string' as const},{id:'second',name:'second',type:'string' as const},{id:'third',name:'third',type:'string' as const}]
    const {id}=await savedExtraction(fixture,nodes,['Original title','Second value','Third value'])
    await fixture.open();await page.locator('#rail-tab-results').click()
    await page.getByRole('button',{name:/To check title Original title/}).click()
    await page.getByRole('button',{name:'Edit',exact:true}).click()
    await page.getByRole('textbox',{name:'Reviewed value'}).fill('Saved title')
    await page.route(`**/api/extractions/${id}/durable/values?*`,async route=> {
      const response=await route.fetch();requested.resolve();await held.promise;await route.fulfill({response})
    })
    await page.getByRole('button',{name:'Save edit',exact:true}).click();await requested.promise
    await page.getByRole('button',{name:/To check third Third value/}).click()
    const review=page.getByRole('region',{name:'Review third',exact:true})
    await review.getByRole('button',{name:'Edit',exact:true}).click()
    await review.getByRole('textbox',{name:'Reviewed value'}).fill('Keep this unsaved draft')
    held.resolve()
    await expect(page.getByText('Selected results 1 · decisions 1',{exact:false})).toBeVisible()
    await expect(review.getByRole('textbox',{name:'Reviewed value'})).toHaveValue('Keep this unsaved draft')
    const saved=(await (await page.request.get(`/api/extractions/${id}/durable/values`)).json()).values
    expect(saved.find((value:{id:string})=>value.id==='title').correction.decision.value).toBe('Saved title')
    expect(saved.find((value:{id:string})=>value.id==='third').correction).toBeNull()
  } finally {held.resolve();await fixture.close()}
})

test('feedback-only lag names the older pair before browser finalization',async({page})=> {
  const fixture=await prepareInteractiveDocument(page,{hasKey:false})
  try {
    const {id}=await savedExtraction(fixture,[{id:'title',name:'title',type:'string'}],['Original title'])
    const root=`/api/extractions/${id}/durable`,headers={Origin:E2E_ORIGIN}
    expect((await page.request.post(`${root}/values/title`,{headers,data:{expectedRevision:0,snapshotVersion:1,action:'APPROVED'}})).ok()).toBe(true)
    await page.goto(`${fixture.url}?extractionId=${id}&snapshotVersion=1&feedbackVersion=1`)
    await page.locator('#rail-tab-results').click()
    await expect(page.getByText('Selected results 1 · decisions 1',{exact:false})).toBeVisible()
    expect((await page.request.post(`${root}/values/title`,{headers,data:{expectedRevision:1,snapshotVersion:1,action:'EDITED',value:'Newer decision'}})).ok()).toBe(true)
    await expect(page.getByText('Newer saved decisions 2 exist.',{exact:false})).toBeVisible()
    await page.getByRole('button',{name:'Finalize results 1 · decisions 1',exact:true}).first().click()
    await expect(page.getByText('Finalized review · results 1 · decisions 1. Later work and decisions remain separate.',{exact:true})).toBeVisible()
    const older=(await (await page.request.get(`${root}/values?snapshotVersion=1&feedbackVersion=1`)).json())
    expect(older.finalization).toMatchObject({snapshotVersion:1,feedbackVersion:1})
    const live=(await (await page.request.get(`${root}/values`)).json())
    expect(live.feedbackVersion).toBe(2)
    expect(live.values[0].correction.decision.value).toBe('Newer decision')
  } finally {await fixture.close()}
})
