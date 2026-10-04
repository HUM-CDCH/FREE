import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { Client } from 'pg'
import { migrate, provisionDatabase, seedPreMigrationHistory, snapshotHistory } from './record-scope-history-fixture.js'
import { ensureKeiRole, EXTRACTION_RUNTIME_ROUTINES } from './kei-role.js'

const baseUrl = process.env.PROJECT_STORE_POSTGRES_URL

test('protocol expansion preserves legacy history and exposes only fenced worker routines', async () => {
  if (!baseUrl) throw new Error('Set PROJECT_STORE_POSTGRES_URL to an explicit disposable free_test_* target.')
  const suffix = randomBytes(5).toString('hex')
  const target = await provisionDatabase(baseUrl, `free_test_durable_${suffix}`)
  const owner = new Client({ connectionString: target.url })
  const role = `free_test_durable_kei_${suffix}`
  const schema = `free_test_durable_dbos_${suffix}`
  const password = randomBytes(24).toString('hex')
  let worker: Client | undefined
  after(async () => {
    await worker?.end()
    await owner.end()
    await target.drop()
    const maintenanceUrl = new URL(baseUrl); maintenanceUrl.pathname = '/postgres'
    const maintenance = new Client({ connectionString: maintenanceUrl.toString() })
    await maintenance.connect()
    try { await maintenance.query(`DROP ROLE IF EXISTS ${role}`) } finally { await maintenance.end() }
  })
  await migrate(target.url, '20261003T1357_start_page')
  await owner.connect()
  const history = await seedPreMigrationHistory(owner)
  const before = await snapshotHistory(owner)
  assert.deepEqual((await migrate(target.url)).applied, ['20261004T1159_durable_extraction'])
  assert.deepEqual(await snapshotHistory(owner), before)
  assert.deepEqual((await migrate(target.url)).applied, [])
  await ensureKeiRole(owner, { role, schema, password })
  await ensureKeiRole(owner, { role, schema, password })
  const url = new URL(target.url); url.username = role; url.password = password
  worker = new Client({ connectionString: url.toString() }); await worker.connect()
  assert.deepEqual((await worker.query('SELECT extraction_runtime.capabilities() AS value')).rows[0].value, { protocol: 1 })
  for (const sql of ['SELECT * FROM public.extraction', 'CREATE TABLE public.evil (id int)',
    'SELECT * FROM extraction_runtime.head', 'UPDATE extraction_runtime.head SET deleted = true',
    'CREATE TABLE extraction_runtime.evil (id int)', "SELECT extraction_runtime.content_hash('{}')",
    `SELECT extraction_runtime.authorized('${randomUUID()}', '${randomUUID()}', 1)`])
    await assert.rejects(worker.query(sql), (e: { code?: string }) => e.code === '42501', sql)
  const grants = await owner.query<{ name: string; allowed: boolean }>(`SELECT p.oid::regprocedure::text AS name,
    has_function_privilege($1, p.oid, 'EXECUTE') AS allowed FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'extraction_runtime'`, [role])
  assert.equal(grants.rows.filter(r => r.allowed).length, EXTRACTION_RUNTIME_ROUTINES.length)
  // Calls admitted before PAUSE drain; newly captured calls are refused.
  const extraction = history.extractions.article.inFlight, selection = randomUUID(), attempt = randomUUID(), process = randomUUID()
  const flagNode={id:'flag',name:'flag',type:'boolean'},arrayNode={id:'items',name:'items',type:'array',itemType:'integer'}
  await owner.query(`INSERT INTO extraction_runtime.head
    (id,"projectId","sourceRevisionId","sourcePin",strategy,"selectionId",intent,"controlVersion","pendingResume",acknowledgement,"attemptId",fence,"leaseEpoch",generation,"snapshotVersion",deleted)
    VALUES ($1,$2,$3,$4,'ARTICLE',$5,'RUN',0,false,'QUEUED',$6,1,0,1,0,false)`,
    [extraction,history.projectContextId,randomUUID(),{runId:'source',generation:'g1'},selection,attempt])
  await owner.query(`INSERT INTO extraction_runtime.selection (id,"extractionId",ordinal,"schemaRevisionId","schemaHash","schemaTree",method,resolved,digest)
    VALUES ($1,$2,1,$3,$4,$5,'{}','{}',$4)`, [selection,extraction,history.revisions.article,'a'.repeat(64),{recordDescription:'document',schemaNodes:[flagNode,arrayNode]}])
  await owner.query(`INSERT INTO extraction_runtime.attempt (id,"extractionId","selectionId",fence,"workflowId") VALUES ($1,$2,$3,1,$4)`,
    [attempt,extraction,selection,`test:${attempt}`])
  await owner.query('INSERT INTO extraction_runtime."feedbackHead" (id,version) VALUES ($1,0)', [history.projectContextId])
  const invoke = async (name:string,args:unknown[]) => (await worker!.query(`SELECT extraction_runtime.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS v`,args)).rows[0].v
  const claim = await invoke('claim',[extraction,attempt,process]), epoch = claim.epoch
  const unit = randomUUID(), plan = await invoke('publish_plan',[extraction,attempt,epoch,randomUUID(),'record',
    {plannerVersion:1,selectionId:selection,sourceGeneration:'g1',units:[{key:'record-1'},{key:'record-2'}],coverage:{}}])
  const descriptor={stage:'record',scope:'source-anchor',ordinal:0,planDigest:plan.digest,role:'fields'}
  const capture=await invoke('capture_unit',[extraction,attempt,epoch,unit,'record-1',descriptor])
  assert.equal(capture.feedbackVersion,0)
  const provider={key:'stub',model:'stub',adapter:'instruct',adapterVersion:1,url:'http://stub/v1/chat/completions',timeout:60,maxTokens:100}
  await invoke('resolve_selection',[extraction,attempt,epoch,{models:{fields:provider,reasoning:provider},options:{},planner:1,protocols:{calls:1,source:'document'}}])
  const body={provider,composer:1,tokenizer:{model:'stub'},budget:{counted:10,context:1000,reserve:100},examples:[],omissions:[],
    body:{stage:'record',record:0,system:'instructions',user:'exact original',schema:{type:'object'},max_tokens:100,max_whitespace:null,
      httpRequest:{model:'stub',messages:[{role:'user',content:'exact original'}],max_tokens:100}}}
  await assert.rejects(invoke('finalize_input',[extraction,attempt,epoch,unit,{...body,provider:{...provider,password:'must not persist'}}]),(e:{code?:string})=>e.code==='22023')
  const input=await invoke('finalize_input',[extraction,attempt,epoch,unit,body])
  assert.equal(await invoke('begin_call',[extraction,attempt,epoch,unit]),true)
  await owner.query("UPDATE extraction_runtime.head SET intent='PAUSE' WHERE id=$1",[extraction])
  assert.equal(await invoke('capture_unit',[extraction,attempt,epoch,randomUUID(),'record-2',{...descriptor,ordinal:1}]),null)
  await assert.rejects(invoke('acknowledge',[extraction,attempt,epoch,false,null]),(e:{code?:string})=>e.code==='55000')
  const output=await invoke('commit_output',[extraction,attempt,epoch,unit,input.digest,{parsed:{title:'saved'}}])
  assert.deepEqual(await invoke('commit_output',[extraction,attempt,epoch,unit,input.digest,{parsed:{title:'saved'}}]),output)
  const value={id:'value-flag',recordId:'document',fieldId:'flag',path:['records',0,'flag'],selectionId:selection,
    schemaRevisionId:history.revisions.article,node:flagNode,modelValue:false,evidence:[],grounding:'ungrounded',processing:'saved',lineage:[]}
  const coverage={sourceGeneration:'g1',completedScopes:{},processingComplete:false}
  for(const invalid of [{...value,selectionId:null},{...value,grounding:'made-up'},{...value,modelValue:'yes'}])
    await assert.rejects(invoke('publish_snapshot',[extraction,attempt,epoch,randomUUID(),selection,JSON.stringify([invalid]),coverage]),(e:{code?:string})=>e.code==='22023')
  const snapshotId=randomUUID()
  const snapshot=await invoke('publish_snapshot',[extraction,attempt,epoch,snapshotId,selection,JSON.stringify([value]),coverage])
  assert.equal(snapshot.values[0].modelValue,false)
  assert.deepEqual(await invoke('publish_snapshot',[extraction,attempt,epoch,snapshotId,selection,JSON.stringify([value]),coverage]),snapshot)
  const arrayValue={...value,id:'value-items',fieldId:'items',node:arrayNode,path:['records',0,'items'],modelValue:[1,2]}
  const next=await invoke('publish_snapshot',[extraction,attempt,epoch,randomUUID(),selection,JSON.stringify([arrayValue]),coverage])
  assert.equal(next.values.length,2)
  await assert.rejects(invoke('heartbeat',[extraction,attempt,null]),(e:{code?:string})=>e.code==='40001')
  assert.equal(await invoke('acknowledge',[extraction,attempt,epoch,false,null]),'PAUSED')
  await assert.rejects(invoke('heartbeat',[extraction,attempt,epoch]),(e:{code?:string})=>e.code==='40001')
  // A takeover changes only lease authorization, leaving the input/origin untouched.
  await owner.query("UPDATE extraction_runtime.attempt SET outcome=NULL WHERE id=$1",[attempt])
  const second=await invoke('claim',[extraction,attempt,randomUUID()])
  assert.equal(second.epoch,epoch+1)
  await assert.rejects(invoke('commit_output',[extraction,attempt,epoch,unit,input.digest,{}]),(e:{code?:string})=>e.code==='40001')
  const stored=await owner.query('SELECT * FROM extraction_runtime.capture WHERE id=$1',[unit])
  assert.equal(stored.rows[0].originalAttemptId,attempt)
  await assert.rejects(owner.query("UPDATE extraction_runtime.input SET request='{}' WHERE id=$1",[unit]),(e:{code?:string})=>e.code==='55000')
  const denied = await owner.query(`SELECT has_schema_privilege('free_extraction_runtime', 'public', 'USAGE') AS allowed`)
  assert.equal(denied.rows[0].allowed, false)
})
