import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes,randomUUID } from 'node:crypto'
import { mkdtemp,writeFile,rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { Client,Pool } from 'pg'
import { migrate,provisionDatabase,seedPreMigrationHistory } from '../../db/src/record-scope-history-fixture.js'
import { ensureKeiRole } from '../../db/src/kei-role.js'
import { createDurableRepository,initializeDurableExtraction } from './durable-repository.js'
import { durableTestNetwork } from './durable-test-network.js'

test('all four real durable methods drain Pause, cancel pending Resume and retain work through Resume or Stop',
  {skip:process.env.FREE_SKIP_PYTHON==='1'?'Python worker checks run on the full verification host.':false},async t=> {
  const network=durableTestNetwork()
  const base=process.env.EXTRACTION_TEST_DATABASE_URL
  if(!base)throw new Error('Set EXTRACTION_TEST_DATABASE_URL to a guarded disposable target.')
  const suffix=randomBytes(5).toString('hex'),target=await provisionDatabase(base,`free_test_durable_lifecycle_${suffix}`)
  const admin=new Client({connectionString:target.url}),source=new Pool({connectionString:target.url,max:4})
  const role=`free_test_durable_lifecycle_${suffix}`,directory=await mkdtemp(resolve(tmpdir(),'free-durable-lifecycle-'))
  t.after(async()=> {
    await source.end();await admin.end();await target.drop();await rm(directory,{recursive:true,force:true})
    const maintenance=new URL(base);maintenance.pathname='/postgres'
    const client=new Client({connectionString:maintenance.toString()});await client.connect()
    try{await client.query(`DROP ROLE IF EXISTS ${role}`)}finally{await client.end()}
  })
  await migrate(target.url);await admin.connect()
  const fixture=await seedPreMigrationHistory(admin),document=fixture.documents.d2,password=randomBytes(24).toString('hex')
  await ensureKeiRole(admin,{role,password,schema:'kei_dbos'})
  const worker=new URL(target.url);worker.username=role;worker.password=password
  const cases:{method:string;terminal:string;id:string;attempt:string;workflow:string;source:unknown}[]=[]
  const scenarios=[...['article','generic','recipe','unified'].flatMap(method=>['complete','stop','failure'].map(terminal=>({method,terminal}))),
    {method:'article',terminal:'queued-pause'},{method:'article',terminal:'after-queued-pause'},
    {method:'unified',terminal:'truncation'},{method:'unified',terminal:'truncation-exhausted'}]
  for(const [index,{method,terminal}] of scenarios.entries()) {
    const schemaRevisionId=randomUUID(),id=randomUUID()
    const nodes=method==='recipe'?[
      {id:'n',name:'entry_no',type:'integer'},{id:'s',name:'site_name',type:'string'},
      {id:'m',name:'mbl_old',type:'integer'},{id:'f',name:'fundart',type:'string'},
    ]:method==='unified'?[
      {id:'l',name:'label',type:'string'},{id:'s',name:'site',type:'string'},
      {id:'m',name:'material',type:'string'},{id:'g',name:'gilded',type:'boolean'},
      {id:'f',name:'finds',type:'array',children:[{id:'fn',name:'name',type:'string'},{id:'fc',name:'count',type:'integer'}]},
    ]:[{id:'name',name:'name',type:'string'}]
    const tree={recordDescription:'One numbered source record.',schemaNodes:nodes}
    await admin.query(`INSERT INTO public."schemaRevision" (id,"extractionSchemaId","revisionNumber",origin,"schemaTree","recordScope")
      SELECT $1,"extractionSchemaId",$2,'RESEARCHER_EDIT',$3,$4 FROM public."schemaRevision" WHERE id=$5`,
      [schemaRevisionId,2+index,tree,method==='article'?'document':'records',fixture.revisions.catalog])
    const settings={[method]:method==='unified'?{defaults:1}:null},strategy=method==='article'?'ARTICLE':'CATALOG',recipe=method==='recipe'?'numbered-catalogue-de@1':null
    await admin.query(`INSERT INTO public.extraction (id,"sourceDocumentId","sourceRepresentationRevisionId","schemaRevisionId",strategy,"catalogRecipe","requestedSettings") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id,document.sourceDocumentId,document.sourceRepresentationRevisionId,schemaRevisionId,strategy,recipe,settings])
    await admin.query('BEGIN')
    try{await initializeDurableExtraction(admin as never,id,{projectContextId:fixture.projectContextId,
      sourceRepresentationRevisionId:document.sourceRepresentationRevisionId,schemaRevisionId,schemaTree:tree,strategy,catalogRecipe:recipe,
      preprocessId:`kei-exp:durable-${method}-${terminal}-${suffix}:g1`,requestedModels:null,requestedSettings:settings});await admin.query('COMMIT')}
    catch(error){await admin.query('ROLLBACK');throw error}
    const head=(await admin.query('SELECT * FROM extraction_runtime.head WHERE id=$1',[id])).rows[0]
    const attempt=(await admin.query('SELECT "workflowId" FROM extraction_runtime.attempt WHERE id=$1',[head.attemptId])).rows[0]
    cases.push({method,terminal,id,attempt:head.attemptId,workflow:attempt.workflowId,source:head.sourcePin})
  }
  const repository=createDurableRepository(fixture.accountId,source),token=randomBytes(24).toString('hex')
  const server=createServer(async(request,response)=> {
    try {
      if(request.headers.authorization!==`Bearer ${token}`) {response.writeHead(403).end();return}
      const buffers=[];for await(const chunk of request)buffers.push(chunk)
      const input=JSON.parse(Buffer.concat(buffers).toString()) as {id:string;action?:string}
      if(!cases.some(value=>value.id===input.id)){response.writeHead(404).end();return}
      if(input.action)await repository.command(input.id,{id:randomUUID(),expectedVersion:(await repository.read(input.id)).controlVersion,action:input.action})
      const state=await repository.read(input.id),page=await repository.page(input.id),history=await repository.history(input.id)
      const attempt=history.attempts.at(-1)
      response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({state,page,history,attempt}))
    } catch(error){response.writeHead(500).end(JSON.stringify({error:error instanceof Error?error.message:'fixture command failed'}))}
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())))
  const port=(server.address() as {port:number}).port
  await writeFile(resolve(directory,'fixture.json'),JSON.stringify({admin:target.url,worker:worker.toString(),cases,bridge:`http://127.0.0.1:${port}`,token}),{mode:0o600})
  const root=resolve(import.meta.dirname,'../../..')
  const {stdout}=await promisify(execFile)('docker',['run','--rm','--network',network,'--entrypoint','sh','-e','PYTHONDONTWRITEBYTECODE=1',
    '-e','DURABLE_LIFECYCLE_FIXTURE=/fixture/fixture.json','-v',`${root}/apps/parsing_service:/test:ro`,'-v',`${directory}:/fixture:ro`,'-w','/test',
    process.env.DURABLE_TEST_WORKER_IMAGE??'free-parsing_worker','-c',
    'uv pip install --python /app/.venv/bin/python pytest==9.1.1 && /app/.venv/bin/python -m pytest -q --tb=short -o cache_dir=/tmp/pytest_cache tests/test_durable_lifecycle.py'],
    {timeout:300000,maxBuffer:4*1024*1024}).catch((error:{stdout?:string;stderr?:string})=> {
      console.info(error.stdout);throw new Error('Guarded four-method lifecycle verification failed.')
    })
  assert.match(stdout,/15 passed/)
  console.info('Article, generic, recipe and unified native Pause/Resume/Stop/Retry and queued lane-release checks passed.')
})
