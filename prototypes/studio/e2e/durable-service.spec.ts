import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {expect,test} from '@playwright/test'
import {strFromU8,unzipSync} from 'fflate'
import {withPoolClientTransaction} from 'db'
import {initializeDurableExtraction,DURABLE_RELEASE_VERIFIED} from 'extraction/durable'
import type {SchemaNode} from 'extraction/schema'
import {E2E_ORIGIN,loginResearcher} from './auth.js'
import {cataloguePdf,numberedCataloguePdf,startRealService} from './realService.js'
import {admit,settle} from './sourceIngestion.js'

const siteNodes:SchemaNode[]=[{id:'site',name:'site',type:'verbatim-string'},{id:'finds',name:'finds',type:'verbatim-string'},{id:'year',name:'year',type:'integer'}]
const methods=['article','generic','recipe','unified'] as const

for(const method of methods) {
  test(`native ${method} controls drain a real worker and retained review survives reload and export`,async({page},testInfo)=>{
    // The counted hold belongs to the deterministic provider. Real-model
    // interoperability is a separate run without exact answer/count assertions.
    test.skip(Boolean(process.env.FREE_REAL_EXTRACT_URL),'The drain assertion needs the counted provider hold.')
    expect(DURABLE_RELEASE_VERIFIED).toBe(false)
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
      const reopen=await (await page.request.get(`/api/project-contexts/${project}/source-documents/${sourceId}/reopen`)).json()
      const sourceRevisionId=reopen.sourceRepresentation.sourceRepresentationId as string
      const nodes:SchemaNode[]=method==='article'?[{id:'sites',name:'sites',type:'array',children:siteNodes}]
        :method==='recipe'?[{id:'entry_no',name:'entry_no',type:'integer'},{id:'kreis',name:'kreis',type:'verbatim-string'},
          {id:'fundart',name:'fundart',type:'verbatim-string'},{id:'site_name',name:'site_name',type:'verbatim-string'}]:siteNodes
      const tree={recordDescription:method==='article'?'All numbered sites in this document.':'One numbered catalogue entry.',schemaNodes:nodes}
      const revision=await page.request.post('/api/schema-revisions',{headers,data:{projectContextId:project,...tree,recordScope:method==='article'?'document':'records'}})
      expect(revision.status(),await revision.text()).toBe(201)
      const schemaRevisionId=(await revision.json()).revision.schemaRevisionId as string,id=randomUUID()
      const strategy=method==='article'?'ARTICLE':'CATALOG',recipe=method==='recipe'?'numbered-catalogue-de@1':null
      const settings={[method]:method==='unified'?{defaults:1}:null}
      service.holdNextExtraction()
      // startRealService refuses every database except its owned guarded stack.
      // Seed through the normal initializer; the production admission gate stays OFF.
      await withPoolClientTransaction(async(_tx,client)=>{
        const representation=(await client.query('SELECT "preprocessId" FROM public."sourceRepresentationRevision" WHERE id=$1',[sourceRevisionId])).rows[0]
        await client.query(`INSERT INTO public.extraction (id,"sourceDocumentId","sourceRepresentationRevisionId","schemaRevisionId",strategy,"catalogRecipe","requestedSettings") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id,sourceId,sourceRevisionId,schemaRevisionId,strategy,recipe,settings])
        await initializeDurableExtraction(client,id,{projectContextId:project,sourceRepresentationRevisionId:sourceRevisionId,schemaRevisionId,schemaTree:tree,
          strategy,catalogRecipe:recipe,preprocessId:representation.preprocessId,requestedModels:null,requestedSettings:settings})
      })
      await service.reconcileDurable()
      await expect.poll(()=>service.extractionHeld(),{timeout:60_000}).toBe(true)
      const state=async()=>await (await page.request.get(`/api/extractions/${id}/durable`)).json()
      expect((await state()).counts.inFlight).toBeGreaterThan(0)
      await page.goto(`/projects/${project}/documents/${sourceId}?extractionId=${id}`)
      await page.locator('#rail-tab-results').click()
      const rail=page.getByRole('complementary',{name:'Evidence, schema and results'})
      await rail.getByRole('button',{name:'Pause',exact:true}).click()
      await expect(rail.getByText('Pausing',{exact:true})).toBeVisible()
      expect((await state()).counts.inFlight).toBeGreaterThan(0)
      const before=await (await page.request.get(`/api/extractions/${id}/durable/history`)).json()
      const captured=before.captures.filter((capture:{request:unknown})=>capture.request!==null)
      expect(captured.length).toBeGreaterThan(0)
      service.releaseExtraction()
      await expect.poll(async()=> (await state()).status,{timeout:60_000}).toBe('PAUSED')
      expect((await state()).counts.inFlight).toBe(0)
      await rail.getByRole('button',{name:'Resume',exact:true}).click()
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
      const downloading=page.waitForEvent('download')
      await page.getByRole('menuitem',{name:'Export CSV bundle'}).click()
      const files=unzipSync(new Uint8Array(await readFile((await (await downloading).path())!)))
      const exported=JSON.parse(strFromU8(files['snapshot.json']))
      expect(exported.values.find((each:{id:string})=>each.id===value.id).correction.decision.value).toEqual(corrected)
      expect(exported.history.captures.some((capture:{outputDigest:unknown})=>capture.outputDigest)).toBe(true)
      await page.screenshot({path:testInfo.outputPath(`native-${method}-retained.png`),fullPage:true})
    } finally {service.releaseExtraction();await service.close()}
  })
}
