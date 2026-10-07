import {randomUUID} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
import {expect,test,type Page} from '@playwright/test'
import {withPoolClientTransaction} from 'db'
import {initializeDurableExtraction} from 'extraction/durable'
import type {SchemaNode} from 'extraction/schema'
import {E2E_ORIGIN,loginResearcher} from './auth.js'
import {cataloguePdf,numberedCataloguePdf,startRealService,textPdf} from './realService.js'
import {admit,settle} from './sourceIngestion.js'

const siteNodes:SchemaNode[]=[{id:'site',name:'site',type:'verbatim-string'},{id:'finds',name:'finds',type:'verbatim-string'},{id:'year',name:'year',type:'integer'}]
const methods=['article','generic','recipe','unified'] as const
type Method=typeof methods[number]
/** A readable CSV header names a field's column after it, or flattens the field into path columns under it (`sites.0.site`). */
const hasColumn=(header:string,name:string)=>header.split(',').some(column=>column===name||column.startsWith(`${name}.`))

async function seedNative(page:Page,project:string,sourceId:string,method:Method,
  options:{nodes?:SchemaNode[];schemaRevisionId?:string;articleContext?:'full'|'bounded';models?:{fields:'gliformer'|'instruct';reasoning:'instruct'}}={}) {
  const reopen=await (await page.request.get(`/api/project-contexts/${project}/source-documents/${sourceId}/reopen`)).json()
  const sourceRevisionId=reopen.sourceRepresentation.sourceRepresentationId as string
  const nodes=options.nodes??(method==='article'?[{id:'sites',name:'sites',type:'array' as const,children:siteNodes}]
    :method==='recipe'?[{id:'entry_no',name:'entry_no',type:'integer' as const},{id:'kreis',name:'kreis',type:'verbatim-string' as const},
      {id:'fundart',name:'fundart',type:'verbatim-string' as const},{id:'site_name',name:'site_name',type:'verbatim-string' as const}]:siteNodes)
  const tree={recordDescription:method==='article'?'All numbered sites in this document.':'One numbered catalogue entry.',schemaNodes:nodes}
  let schemaRevisionId=options.schemaRevisionId
  if(!schemaRevisionId) {
    const revision=await page.request.post('/api/schema-revisions',{headers:{Origin:E2E_ORIGIN},data:{projectContextId:project,...tree,recordScope:method==='article'?'document':'records'}})
    expect(revision.status(),await revision.text()).toBe(201)
    schemaRevisionId=(await revision.json()).revision.schemaRevisionId as string
  }
  const id=randomUUID()
  const strategy=method==='article'?'ARTICLE':'CATALOG',recipe=method==='recipe'?'numbered-catalogue-de@1':null
  const settings={[method]:method==='unified'?{defaults:1}:method==='article'&&options.articleContext
    ?{context:options.articleContext,context_tokens:8192}:null},models=options.models??null
  // All callers start the service helper, which refuses every database except
  // its owned guarded stack. Use the normal initializer to seed saved producer data.
  await withPoolClientTransaction(async(_tx,client)=>{
    const representation=(await client.query('SELECT "preprocessId" FROM public."sourceRepresentationRevision" WHERE id=$1',[sourceRevisionId])).rows[0]
    await client.query(`INSERT INTO public.extraction (id,"sourceDocumentId","sourceRepresentationRevisionId","schemaRevisionId",strategy,"catalogRecipe","requestedModels","requestedSettings") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id,sourceId,sourceRevisionId,schemaRevisionId,strategy,recipe,models,settings])
    await initializeDurableExtraction(client,id,{projectContextId:project,sourceRepresentationRevisionId:sourceRevisionId,schemaRevisionId,schemaTree:tree,
      strategy,catalogRecipe:recipe,preprocessId:representation.preprocessId,requestedModels:models,requestedSettings:settings})
  })
  return id
}

for(const method of methods) {
  test(`native ${method} controls drain a real worker and retained review survives reload and export`,async({page},testInfo)=>{
    // The counted hold belongs to the deterministic provider. Real-model
    // interoperability is a separate run without exact answer/count assertions.
    test.skip(Boolean(process.env.FREE_REAL_EXTRACT_URL),'The drain assertion needs the counted provider hold.')
    const service=await startRealService(testInfo.outputPath('durable-worker.log'))
    try {
      await loginResearcher(page,randomUUID())
      const headers={Origin:E2E_ORIGIN}
      const created=await page.request.post('/api/project-contexts',{headers,data:{name:`Native durable ${method}`}})
      expect(created.status()).toBe(201)
      const project=(await created.json()).projectContext.projectContextId as string
      const ingestion=await settle(page,project,await admit(page,project,method==='recipe'?numberedCataloguePdf():cataloguePdf(),'native.pdf'),180_000)
      expect(ingestion.status,JSON.stringify(ingestion)).toBe('succeeded')
      if(ingestion.status!=='succeeded')throw new Error('The disposable native source was not published.')
      const sourceId=ingestion.sourceDocumentId
      service.holdNextExtraction()
      const id=await seedNative(page,project,sourceId,method)
      await service.reconcileDurable()
      await expect.poll(()=>service.extractionHeld(),{timeout:60_000}).toBe(true)
      const state=async()=>await (await page.request.get(`/api/extractions/${id}/durable`)).json()
      expect((await state()).counts.inFlight).toBeGreaterThan(0)
      await page.goto(`/projects/${project}/documents/${sourceId}?extractionId=${id}`)
      await page.locator('#rail-tab-results').click()
      const rail=page.getByRole('complementary',{name:'Evidence, schema and results'})
      await page.getByRole('button',{name:'❚❚ Pause extraction',exact:true}).click()
      await expect(rail.getByText('Pausing',{exact:true})).toBeVisible()
      expect((await state()).counts.inFlight).toBeGreaterThan(0)
      const before=await (await page.request.get(`/api/extractions/${id}/durable/history`)).json()
      const captured=before.captures.filter((capture:{request:unknown})=>capture.request!==null)
      expect(captured.length).toBeGreaterThan(0)
      service.releaseExtraction()
      await expect.poll(async()=>{
        const head=await state()
        if(head.status==='FAILED') {
          await writeFile(testInfo.outputPath('failed-native-history.json'),JSON.stringify(await (await page.request.get(`/api/extractions/${id}/durable/history`)).json(),null,2))
          throw new Error(JSON.stringify(head.failure))
        }
        return head.status
      },{timeout:60_000}).toBe('PAUSED')
      expect((await state()).counts.inFlight).toBe(0)
      await page.getByRole('button',{name:'▶ Resume extraction',exact:true}).click()
      await expect.poll(async()=>{
        const head=await state()
        if(head.status==='FAILED')throw new Error(JSON.stringify(head.failure))
        return head.status
      },{timeout:180_000}).toBe('COMPLETED')
      expect((await state()).extractionId).toBe(id)
      const after=await (await page.request.get(`/api/extractions/${id}/durable/history`)).json()
      for(const original of captured)expect(after.captures.find((capture:{id:string})=>capture.id===original.id).request).toEqual(original.request)
      const saved=await (await page.request.get(`/api/extractions/${id}/durable/values`)).json()
      const value=saved.values.find((each:{processing:string;node:{type:string}})=>each.processing==='saved'&&['string','verbatim-string'].includes(each.node.type))??saved.values.find((each:{processing:string})=>each.processing==='saved')
      expect(value).toBeDefined()
      await page.goto(`/projects/${project}/documents/${sourceId}?extractionId=${id}&value=${encodeURIComponent(value.id)}`)
      await page.locator('#rail-tab-results').click()
      const review=page.getByRole('region',{name:`Review ${value.node.name}`,exact:true})
      await review.getByRole('button',{name:'Edit',exact:true}).click()
      const corrected=['string','verbatim-string'].includes(value.node.type)?'Manually retained native correction':value.modelValue
      await review.getByRole('textbox',{name:'Reviewed value'}).fill(typeof corrected==='string'?corrected:JSON.stringify(corrected))
      await review.getByRole('button',{name:'Save edit',exact:true}).click()
      const valueUrl=`/api/extractions/${id}/durable/values/${encodeURIComponent(value.id)}`
      await expect.poll(async()=>(await (await page.request.get(valueUrl)).json()).values[0].correction?.decision.value).toEqual(corrected)
      await page.reload();await page.locator('#rail-tab-results').click()
      await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeVisible()
      await page.getByRole('button',{name:'More result actions'}).click()
      await page.getByRole('menuitem',{name:'Export…'}).click()
      const downloading=page.waitForEvent('download')
      await page.getByRole('button',{name:'CSV',exact:true}).click()
      const csv=await readFile((await (await downloading).path())!,'utf8')
      expect(hasColumn(csv.split('\r\n')[0]!,value.node.name),csv).toBe(true)
      if(typeof corrected==='string')expect(csv).toContain(corrected)
      // Saved model output stays in History, read through its own API, never through the export.
      expect(after.captures.some((capture:{outputDigest:unknown})=>capture.outputDigest)).toBe(true)
      await page.screenshot({path:testInfo.outputPath(`native-${method}-retained.png`),fullPage:true})
    } finally {service.releaseExtraction();await service.close()}
  })
}

for(const context of ['full','bounded'] as const) {
test(`native ${context} Article: an ungrounded UI correction guides a later worker with immutable captured attribution`,async({page},info)=>{
  test.skip(Boolean(process.env.FREE_REAL_EXTRACT_URL),'Guidance attribution uses the counted provider hold.')
  const service=await startRealService(info.outputPath('durable-guidance-worker.log'))
  try {
    await loginResearcher(page,randomUUID())
    const headers={Origin:E2E_ORIGIN}
    const created=await page.request.post('/api/project-contexts',{headers,data:{name:'Native correction guidance'}})
    expect(created.status()).toBe(201)
    const project=(await created.json()).projectContext.projectContextId as string
    const sourceA=await settle(page,project,await admit(page,project,cataloguePdf(),'guidance-a.pdf'),180_000)
    expect(sourceA.status).toBe('succeeded')
    if(sourceA.status!=='succeeded')throw new Error('Guidance source A was not published.')
    const extractionA=await seedNative(page,project,sourceA.sourceDocumentId,'article')
    const complete=async(id:string)=>expect.poll(async()=>{
      const head=await (await page.request.get(`/api/extractions/${id}/durable`)).json()
      if(head.status==='FAILED')throw new Error(JSON.stringify(head.failure))
      return head.status
    },{timeout:180_000}).toBe('COMPLETED')
    await service.reconcileDurable();await complete(extractionA)
    const headA=await (await page.request.get(`/api/extractions/${extractionA}/durable`)).json()
    const savedA=await (await page.request.get(`/api/extractions/${extractionA}/durable/values`)).json()
    const value=savedA.values.find((each:{fieldId:string})=>each.fieldId==='sites')
    expect(value).toBeDefined()
    const corrected=[{site:'Researcher guidance sentinel',finds:'pottery',year:1901}]
    await page.goto(`/projects/${project}/documents/${sourceA.sourceDocumentId}?extractionId=${extractionA}&value=${encodeURIComponent(value.id)}`)
    await page.locator('#rail-tab-results').click()
    const review=page.getByRole('region',{name:'Review sites',exact:true})
    await review.getByRole('button',{name:'Edit',exact:true}).click()
    await review.getByRole('textbox',{name:'Reviewed value'}).fill(JSON.stringify(corrected))
    await review.getByRole('button',{name:'Save edit',exact:true}).click()
    const valueUrl=`/api/extractions/${extractionA}/durable/values/${encodeURIComponent(value.id)}`
    await expect.poll(async()=>(await (await page.request.get(valueUrl)).json()).values[0].correction?.decision.value).toEqual(corrected)
    const correction=(await (await page.request.get(valueUrl)).json()).values[0].correction
    expect(correction.decision.evidence).toEqual([])
    expect(correction.candidate.grounded).toBe(false)
    expect(correction.included).toBe(true)
    const exampleContext=JSON.parse(correction.candidate.sourceContext)
    expect(exampleContext).toMatchObject({sourceRevisionId:headA.sourceRevisionId,recordId:value.recordId,modelValue:value.modelValue,
      correctionEvidence:[],modelEvidence:value.evidence,modelGrounding:value.grounding})
    const pinnedA=await (await page.request.get(`/api/extractions/${extractionA}/durable/source`)).json()
    if(exampleContext.source.scope==='document')expect(exampleContext.source.text).toBe(pinnedA.markdown)
    else expect(exampleContext.source.excerpts.length).toBeGreaterThan(0)

    // Distinct source bytes publish a new source pin while preserving field meaning.
    const sourceB=await settle(page,project,await admit(page,project,Buffer.concat([cataloguePdf(),Buffer.from('\n% guidance source B\n')]),'guidance-b.pdf'),180_000)
    expect(sourceB.status).toBe('succeeded')
    if(sourceB.status!=='succeeded')throw new Error('Guidance source B was not published.')
    expect(sourceB.sourceDocumentId).not.toBe(sourceA.sourceDocumentId)
    service.holdNextExtraction()
    const requestsBefore=service.modelRequests().length
    const extractionB=await seedNative(page,project,sourceB.sourceDocumentId,'article',{schemaRevisionId:value.schemaRevisionId,articleContext:context})
    await service.reconcileDurable()
    const historyUrl=`/api/extractions/${extractionB}/durable/history`
    await expect.poll(async()=>{
      const head=await (await page.request.get(`/api/extractions/${extractionB}/durable`)).json()
      if(head.status==='FAILED') {
        await writeFile(info.outputPath('failed-guidance-history.json'),JSON.stringify({head,history:await (await page.request.get(historyUrl)).json()},null,2))
        throw new Error(JSON.stringify(head.failure))
      }
      return service.extractionHeld()
    },{timeout:60_000}).toBe(true)
    const started=await (await page.request.get(historyUrl)).json()
    const capture=started.captures.find((each:{request:unknown})=>each.request)
    const providerRequest=service.modelRequests()[requestsBefore]
    await writeFile(info.outputPath('guidance-started-request.json'),JSON.stringify({correction,capture,providerRequest},null,2))
    expect(capture.feedbackVersion).toBe(correction.feedbackVersion)
    expect(capture.request.examples).toContainEqual(correction.candidate)
    expect(capture.request.budget.context).toBe(context==='bounded'?8192:16384)
    expect(capture.request.budget.reserve).toBeGreaterThanOrEqual(4096)
    expect(capture.request.body.system).toContain('Researcher guidance sentinel')
    expect(capture.request.body.system).toContain(JSON.stringify(correction.candidate.sourceContext).slice(1,-1))
    expect(capture.request.body.user).not.toContain('Researcher guidance sentinel')
    expect(providerRequest).toEqual(capture.request.body.httpRequest)

    // A later project-guidance edit affects future captures, never this started call.
    await page.goto(`/projects/${project}/documents/${sourceB.sourceDocumentId}?extractionId=${extractionB}`)
    await page.locator('#rail-tab-history').click()
    await expect(page.getByText('In use',{exact:true})).toBeVisible()
    await page.getByRole('button',{name:'Stop using',exact:true}).click()
    await expect(page.getByRole('button',{name:'Use',exact:true})).toBeVisible()
    const guidance=await (await page.request.get(`/api/project-contexts/${project}/feedback?target=${extractionB}`)).json()
    expect(guidance.find((each:{active:boolean})=>each.active)).toMatchObject({revision:2,included:false,candidate:{value:corrected,grounded:false,sourceContext:correction.candidate.sourceContext}})
    expect(guidance.find((each:{id:string})=>each.id===correction.id).active).toBe(false)
    service.releaseExtraction();await complete(extractionB)
    const finished=await (await page.request.get(historyUrl)).json()
    expect(finished.captures.find((each:{id:string})=>each.id===capture.id)).toMatchObject({feedbackVersion:capture.feedbackVersion,request:capture.request})
    expect(finished.captures.find((each:{id:string})=>each.id===capture.id).outputDigest).toBeTruthy()
    for(const later of finished.captures.filter((each:{id:string})=>each.id!==capture.id)) {
      expect(later.request.examples).not.toContainEqual(correction.candidate)
      expect(later.request.body.system).not.toContain('Researcher guidance sentinel')
    }
    const retainedA=(await (await page.request.get(valueUrl)).json()).values[0]
    expect(retainedA.correction.decision.value).toEqual(corrected)
    expect(retainedA.correction.included).toBe(false)
    await page.locator('#rail-tab-results').click()
    await page.getByRole('button',{name:'More result actions'}).click()
    await page.getByRole('menuitem',{name:'Export…'}).click()
    const download=page.waitForEvent('download')
    await page.getByRole('button',{name:'CSV',exact:true}).click()
    const rows=(await readFile((await (await download).path())!,'utf8')).split('\r\n')
    expect(hasColumn(rows[0]!,value.node.name),rows[0]).toBe(true)
    // The producing request stays in History, read through its own API; the research table never carries it.
    await writeFile(info.outputPath('guidance-history.json'),JSON.stringify(finished,null,2))
    await page.locator('#rail-tab-history').click()
    await page.getByRole('button',{name:'Use',exact:true}).click()
    await expect(page.getByRole('button',{name:'Stop using',exact:true})).toBeVisible()
    const reincluded=await (await page.request.get(`/api/project-contexts/${project}/feedback?target=${extractionB}`)).json()
    expect(reincluded.find((each:{active:boolean})=>each.active)).toMatchObject({revision:3,included:true,
      candidate:{value:corrected,grounded:false,sourceContext:correction.candidate.sourceContext}})
    if(context==='full') {
      const batchId=randomUUID()
      await withPoolClientTransaction(async(_tx,client)=>{
        await client.query(`INSERT INTO public."batchExtraction" (id,"projectContextId","schemaRevisionId",strategy,"requestedSettings") VALUES ($1,$2,$3,'ARTICLE',$4)`,
          [batchId,project,value.schemaRevisionId,{article:null}])
        await client.query('UPDATE public.extraction SET "batchExtractionId"=$1 WHERE id=ANY($2::uuid[])',[batchId,[extractionA,extractionB]])
      })
      await page.goto(`/projects/${project}/documents/${sourceA.sourceDocumentId}?extractionId=${extractionA}&fromBatchExtractionId=${batchId}&value=${encodeURIComponent(value.id)}`)
      await page.locator('#rail-tab-results').click()
      await expect(page.getByText('Reviewed 0/2',{exact:true})).toBeVisible()
      await page.getByRole('button',{name:'Save review',exact:true}).click()
      await expect(page.getByText('Reviewed 1/2',{exact:true})).toBeVisible()
      const batch=await (await page.request.get(`/api/batch-extractions/${batchId}?projectContextId=${project}`)).json()
      await writeFile(info.outputPath('native-pilot-review.json'),JSON.stringify(batch,null,2))
      await page.getByRole('button',{name:'Next document'}).click()
      await expect(page).toHaveURL(new RegExp(sourceB.sourceDocumentId))
      const stabilised=await page.request.post('/api/stabilise_schema_revision',{headers,data:{projectContextId:project,schemaRevisionId:value.schemaRevisionId}})
      expect(stabilised.status(),await stabilised.text()).toBe(200)
    }
    await page.screenshot({path:info.outputPath('native-guidance-attribution.png'),fullPage:true})
  } finally {service.releaseExtraction();await service.close()}
})
}

test('deleting a project fences its held native worker and retains another project source',async({page},info)=>{
  test.skip(Boolean(process.env.FREE_REAL_EXTRACT_URL),'Deletion uses the counted provider hold.')
  const service=await startRealService(info.outputPath('durable-deletion-worker.log'))
  try {
    await loginResearcher(page,randomUUID())
    const projects:string[]=[],sources:string[]=[]
    for(const name of ['Delete native work','Keep shared source']) {
      const created=await page.request.post('/api/project-contexts',{headers:{Origin:E2E_ORIGIN},data:{name}})
      expect(created.status()).toBe(201)
      const project=(await created.json()).projectContext.projectContextId as string
      projects.push(project)
      const ingested=await settle(page,project,await admit(page,project,cataloguePdf(),'shared-native.pdf'),180_000)
      expect(ingested.status).toBe('succeeded')
      if(ingested.status!=='succeeded')throw new Error('Shared source fixture was not published.')
      sources.push(ingested.sourceDocumentId)
    }
    service.holdNextExtraction()
    const id=await seedNative(page,projects[0]!,sources[0]!,'article')
    await service.reconcileDurable()
    await expect.poll(()=>service.extractionHeld(),{timeout:60_000}).toBe(true)
    expect(await service.keiWorkflows(`kei-durable:${id}:`)).toHaveLength(1)
    await page.goto(`/projects/${projects[0]}/documents/${sources[0]}?extractionId=${id}`)
    await page.locator('#rail-tab-results').click()
    expect((await page.request.delete(`/api/project-contexts/${projects[0]}`,{headers:{Origin:E2E_ORIGIN}})).status()).toBe(204)
    expect((await page.request.get(`/api/extractions/${id}/durable`)).status()).toBe(404)
    const tombstone=async()=>withPoolClientTransaction(async(_tx,client)=>(await client.query('SELECT deleted,intent FROM extraction_runtime.head WHERE id=$1',[id])).rows[0])
    expect(await tombstone()).toEqual({deleted:true,intent:'STOP'})
    service.releaseExtraction()
    await expect.poll(async()=> (await service.keiWorkflows(`kei-durable:${id}:`)).every(attempt=>['SUCCESS','ERROR'].includes(attempt.status)),{timeout:60_000}).toBe(true)
    expect((await page.request.get(`/api/extractions/${id}`)).status()).toBe(404)
    expect(await tombstone()).toEqual({deleted:true,intent:'STOP'})
    const published=await withPoolClientTransaction(async(_tx,client)=>(await client.query('SELECT count(*)::int AS n FROM extraction_runtime.snapshot WHERE "extractionId"=$1',[id])).rows[0].n)
    expect(published).toBe(0)
    await service.collectGarbage()
    const retained=await page.request.get(`/api/project-contexts/${projects[1]}/source-documents/${sources[1]}/reopen`)
    expect(retained.status(),await retained.text()).toBe(200)
    const canonical=(await retained.json()).sourceRepresentation.resources.parsedDocumentUrl
    expect((await page.request.get(canonical)).status()).toBe(200)
    await page.goto(`/projects/${projects[1]}/documents/${sources[1]}`)
    await expect(page.getByRole('region',{name:'Source Document',exact:true})).toBeVisible()
    await page.screenshot({path:info.outputPath('shared-source-retained.png'),fullPage:true})
  } finally {service.releaseExtraction();await service.close()}
})

for(const method of ['article','unified'] as const) {
  test(`native ${method} retains real provider requests and saved output`,async({page},info)=>{
    test.skip(!process.env.FREE_REAL_EXTRACT_URL,'Requires an explicitly selected real reasoning server.')
    test.skip(method==='unified'&&!process.env.FREE_REAL_GLIFORMER_URL,'Requires the real native fields server.')
    const service=await startRealService(info.outputPath('durable-live-worker.log'))
    try {
      await loginResearcher(page,randomUUID())
      const created=await page.request.post('/api/project-contexts',{headers:{Origin:E2E_ORIGIN},data:{name:`Native live ${method}`}})
      expect(created.status()).toBe(201)
      const project=(await created.json()).projectContext.projectContextId as string
      const ingestion=await settle(page,project,await admit(page,project,cataloguePdf(),'live-native.pdf'),180_000)
      expect(ingestion.status).toBe('succeeded')
      if(ingestion.status!=='succeeded')throw new Error('Live source was not published.')
      const id=await seedNative(page,project,ingestion.sourceDocumentId,method,method==='unified'
        ?{models:{fields:'gliformer',reasoning:'instruct'},nodes:siteNodes.filter(node=>node.type==='verbatim-string')}: {})
      await service.reconcileDurable()
      const state=async()=>await (await page.request.get(`/api/extractions/${id}/durable`)).json()
      await expect.poll(async()=>{
        const head=await state()
        if(head.status==='FAILED')throw new Error(JSON.stringify(head.failure))
        return head.status
      },{timeout:300_000}).toBe('COMPLETED')
      const history=await (await page.request.get(`/api/extractions/${id}/durable/history`)).json()
      const captures=history.captures.filter((capture:{request:unknown})=>capture.request)
      expect(captures.length).toBeGreaterThan(0)
      expect(captures.every((capture:{outputDigest:unknown})=>capture.outputDigest)).toBe(true)
      expect(captures.some((capture:{request:{provider:{model:string}}})=>capture.request.provider.model===process.env.FREE_REAL_EXTRACT_MODEL)).toBe(true)
      if(method==='unified') {
        const native=captures.filter((capture:{request:{provider:{adapter:string}}})=>capture.request.provider.adapter==='gliformer')
        expect(native.length).toBeGreaterThan(0)
        expect(native.every((capture:{request:{provider:{nativeInfo:{protocol:number}}}})=>capture.request.provider.nativeInfo.protocol===1)).toBe(true)
      }
      const saved=await (await page.request.get(`/api/extractions/${id}/durable/values`)).json()
      expect(saved.values.some((value:{processing:string})=>value.processing==='saved')).toBe(true)
      await page.goto(`/projects/${project}/documents/${ingestion.sourceDocumentId}?extractionId=${id}`)
      await page.locator('#rail-tab-results').click()
      await expect(page.getByText('Completed',{exact:true}).first()).toBeVisible()
      await page.getByRole('button',{name:'More result actions'}).click()
      await page.getByRole('menuitem',{name:'Export…'}).click()
      const download=page.waitForEvent('download')
      await page.getByRole('button',{name:'CSV',exact:true}).click()
      const rows=(await readFile((await (await download).path())!,'utf8')).split('\r\n')
      expect(rows.length).toBeGreaterThan(1)
      expect(saved.values.filter((value:{processing:string;node:{name:string}})=>value.processing==='saved'&&!hasColumn(rows[0]!,value.node.name)).map((value:{node:{name:string}})=>value.node.name),rows[0]).toEqual([])
      await page.screenshot({path:info.outputPath(`live-${method}-retained.png`),fullPage:true})
    } finally {await service.close()}
  })
}

const liveSites=['Hill','Valley','Coast','Ridge','Marsh','Ford','Moor','Heath','Grove','Brook','Cliff','Dune','Glen','Bay','Fen','Holm']
const liveFinds=['pottery','flint','copper','bone','amber','glass','iron','bronze']
/** Sixteen numbered entries, four a page, after a heading that is no record. */
function liveCataloguePages(): string[][] {
  const lines=liveSites.map((site,index)=>`${index+1}. ${site}: ${liveFinds[index%liveFinds.length]} dated ${1801+index}.`)
  return [['Site catalogue',...lines.slice(0,3)],...Array.from({length:Math.ceil((lines.length-3)/4)},(_,page)=>lines.slice(3+page*4,7+page*4))]
}

// ADR 0017's live results on a real worker and reasoning server; live-results-evidence.json keeps what the researcher
// saw and what the model received.
test('native unified live results: discovery progress, then each record and its Evidence while the run reads; a mid-run edit guides later calls; pause and resume',async({page},info)=>{
  test.setTimeout(30*60_000)
  test.skip(!process.env.FREE_REAL_EXTRACT_URL,'Requires an explicitly selected real reasoning server.')
  const service=await startRealService(info.outputPath('live-results-worker.log'))
  const shot=(name:string)=>page.screenshot({path:info.outputPath(`${name}.png`)})
  const timeline:unknown[]=[]
  try {
    await loginResearcher(page,randomUUID())
    const project=(await (await page.request.post('/api/project-contexts',{headers:{Origin:E2E_ORIGIN},data:{name:'Live results catalogue'}})).json()).projectContext.projectContextId as string
    const ingestion=await settle(page,project,await admit(page,project,textPdf(liveCataloguePages()),'live-catalogue.pdf'),300_000)
    if(ingestion.status!=='succeeded')throw new Error(`Live source was not published: ${JSON.stringify(ingestion)}`)
    const sourceId=ingestion.sourceDocumentId
    // The reasoning server also reads the fields: its values carry verification links, so Evidence is highlighted.
    const id=await seedNative(page,project,sourceId,'unified',{models:{fields:'instruct',reasoning:'instruct'}})
    await page.goto(`/projects/${project}/documents/${sourceId}?extractionId=${id}`)
    await page.locator('#rail-tab-results').click()
    const rail=page.getByRole('complementary',{name:'Evidence, schema and results'})
    const state=async()=>(await page.request.get(`/api/extractions/${id}/durable`)).json()
    const values=async()=>(await page.request.get(`/api/extractions/${id}/durable/values?limit=500`)).json()
    await service.reconcileDurable()

    // 1. Discovery: the record starts it has found so far, on the rail and on the source.
    let found=0
    await expect.poll(async()=>{
      const head=await state()
      if(head.status==='FAILED')throw new Error(JSON.stringify(head.failure))
      timeline.push({at:Date.now(),status:head.status,records:head.records?.length??null,found:head.discovery?.found?.length??null})
      if(head.records===null&&head.discovery?.found?.length>found)found=head.discovery.found.length
      return found>0||head.records!==null
    },{timeout:600_000,intervals:[300]}).toBe(true)
    if(found>0) {
      await expect(rail.getByText('Finding records',{exact:true})).toBeVisible({timeout:5_000}).catch(()=>{})
      await shot('01-discovery')
    }

    // 2. The planned records, queued and read in turn.
    await expect.poll(async()=>(await state()).records!==null,{timeout:600_000,intervals:[500]}).toBe(true)
    await expect(rail.getByRole('region',{name:/^Record \d+, (Queued|Reading…)$/}).first()).toBeVisible()
    await shot('02-records-planned')

    // 3. Values and their Evidence while the run still reads.
    await expect.poll(async()=>{
      const [head,saved]=await Promise.all([state(),values()])
      return head.status==='RUNNING'&&saved.values.some((value:{links:unknown[]})=>value.links.length>0)
    },{timeout:600_000,intervals:[500]}).toBe(true)
    await expect.poll(async()=>page.locator('.parsed-evidence-highlight').count(),{timeout:30_000}).toBeGreaterThan(0)
    const midRun={status:(await state()).status,highlights:await page.locator('.parsed-evidence-highlight').count(),
      read:await rail.getByRole('region',{name:/^Record \d+, \d+ to check$/}).count(),waiting:await rail.getByRole('region',{name:/^Record \d+, (Queued|Reading…)$/}).count()}
    expect(midRun.status).toBe('RUNNING')
    await shot('03-highlights-while-reading')

    // 4. A fix on the go: an edit saved now is an example in a later call's request.
    await rail.getByRole('button',{name:/^To check finds /}).first().click()
    await rail.getByRole('button',{name:'Edit',exact:true}).click()
    await rail.getByRole('textbox',{name:'Reviewed value'}).fill('Corrected finds sentinel')
    await rail.getByRole('button',{name:'Save edit',exact:true}).click()
    let correctionVersion=0
    await expect.poll(async()=>{
      const saved=(await values()).values.find((value:{correction:{decision:{value:unknown}}|null})=>value.correction?.decision.value==='Corrected finds sentinel')
      correctionVersion=saved?.correction?.feedbackVersion??0
      return correctionVersion
    },{timeout:30_000}).toBeGreaterThan(0)
    await shot('04-edited-mid-run')

    // 5. Pause and resume from the run button.
    await page.getByRole('button',{name:'❚❚ Pause extraction',exact:true}).click()
    await expect(page.getByRole('button',{name:'▶ Resume extraction',exact:true})).toBeVisible({timeout:600_000})
    await shot('05-paused')
    const paused=await values()
    await page.getByRole('button',{name:'▶ Resume extraction',exact:true}).click()
    await expect(page.getByRole('button',{name:/❚❚ Pause extraction|Pausing…/})).toBeVisible({timeout:60_000})

    // 6. Completion.
    await expect.poll(async()=>{
      const head=await state()
      if(head.status==='FAILED')throw new Error(JSON.stringify(head.failure))
      return head.status
    },{timeout:1_200_000,intervals:[1000]}).toBe('COMPLETED')
    await expect(rail.getByText('Completed',{exact:true})).toBeVisible({timeout:30_000})
    await shot('06-completed')

    const history=await (await page.request.get(`/api/extractions/${id}/durable/history`)).json()
    type Capture={id:string;feedbackVersion:number;descriptor:{stage:string};request:{examples:{value:unknown}[];body:{httpRequest:Record<string,unknown>}}|null;output:{parsed:unknown}|null}
    const captures:Capture[]=history.captures
    const guided=captures.filter(capture=>capture.request?.examples.some(example=>example.value==='Corrected finds sentinel'))
    expect(guided.length).toBeGreaterThan(0)
    expect(guided.every(capture=>capture.feedbackVersion>=correctionVersion)).toBe(true)
    const discovery=captures.filter(capture=>capture.descriptor.stage==='discovery')
    expect(discovery.length).toBeGreaterThan(0)
    // The captured request is the exact unstreamed one; only the transport asked for the stream.
    expect(discovery.every(capture=>!('stream' in (capture.request?.body.httpRequest??{})))).toBe(true)
    const events=await withPoolClientTransaction(async(_tx,client)=>{
      const attempts=(await client.query('SELECT id,"workflowId" FROM extraction_runtime.attempt WHERE "extractionId"=$1',[id])).rows
      const workflows=[...attempts.map(attempt=>attempt.workflowId),...attempts.flatMap(attempt=>discovery.map(capture=>`kei-call:${attempt.id}:${capture.id}`))]
      return (await client.query('SELECT workflow_uuid,key FROM kei_dbos.workflow_events WHERE workflow_uuid=ANY($1)',[workflows])).rows as {workflow_uuid:string;key:string}[]
    })
    const final=await values()
    await writeFile(info.outputPath('live-results-evidence.json'),JSON.stringify({id,found,midRun,timeline,correctionVersion,events,
      pausedValues:paused.values.length,finalValues:final.values.length,linked:final.values.filter((value:{links:unknown[]})=>value.links.length>0).length,
      guided:guided.map(capture=>({id:capture.id,stage:capture.descriptor.stage,feedbackVersion:capture.feedbackVersion})),
      discovery:discovery.map(capture=>({id:capture.id,output:capture.output?.parsed})),
      calls:captures.map(capture=>({stage:capture.descriptor.stage,record:(capture.request?.body as {record?:number}|undefined)?.record,
        feedbackVersion:capture.feedbackVersion,examples:capture.request?.examples.length??0,output:capture.output?.parsed})),
      values:final.values.map((value:{path:unknown;modelValue:unknown;links:unknown[];grounding:string;processing:string})=>({path:value.path,value:value.modelValue,
        linked:value.links.length>0,grounding:value.grounding,processing:value.processing}))},null,2))
    expect(events.some(event=>event.key==='discovery')).toBe(true)
    expect(events.some(event=>event.key==='places')).toBe(true)
    expect(found,'discovery progress reached Studio while discovery ran').toBeGreaterThan(0)
    expect(final.values.filter((value:{links:unknown[]})=>value.links.length>0).length).toBeGreaterThan(0)
  } finally {await service.close()}
})
