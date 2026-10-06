import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { after, test } from 'node:test'
import { Client } from 'pg'
import { migrate, provisionDatabase, seedPreMigrationHistory, snapshotHistory } from './record-scope-history-fixture.js'
import { ensureKeiRole, EXTRACTION_RUNTIME_ROUTINES } from './kei-role.js'

const baseUrl = process.env.PROJECT_STORE_POSTGRES_URL
// The durable-first and pilot-first paths out of start_page converge at `20261005T0832_durable_after_pilot`'s target;
// every later migration is on the single shared chain both paths then apply, so it is read from disk, not listed here.
const migrations = new URL('../migrations/app/', import.meta.url)
const sharedChain = readdirSync(migrations)
  .filter((name) => name > '20261005T0832_durable_after_pilot' && existsSync(new URL(`${name}/migration.json`, migrations))).sort()

test('the durable-first upgrade converges with pilot-first without rewriting history', async () => {
  if (!baseUrl) throw new Error('Set PROJECT_STORE_POSTGRES_URL to an explicit disposable free_test_* target.')
  const target = await provisionDatabase(baseUrl, `free_test_durable_bridge_${randomBytes(5).toString('hex')}`)
  const owner = new Client({ connectionString: target.url })
  try {
    await migrate(target.url, '20261003T1357_start_page')
    await owner.connect()
    await seedPreMigrationHistory(owner)
    const before = await snapshotHistory(owner)
    assert.deepEqual((await migrate(target.url, '20261004T1351_durable_retry_history')).applied,
      ['20261004T1159_durable_extraction', '20261004T1351_durable_retry_history'])
    assert.deepEqual((await migrate(target.url)).applied, ['20261005T0831_pilot_after_durable', ...sharedChain])
    assert.deepEqual(await snapshotHistory(owner), before)
    assert.deepEqual((await migrate(target.url)).applied, [])
    assert.equal((await owner.query('SELECT extraction_runtime.capabilities() AS value')).rows[0].value.protocol, 1)
    await owner.query('SELECT "stabilisedAt" FROM public."schemaRevision" LIMIT 1')
  } finally {
    await owner.end()
    await target.drop()
  }
})

test('protocol expansion preserves existing public rows and exposes only fenced worker routines', async () => {
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
  assert.deepEqual((await migrate(target.url)).applied, ['20261004T1635_project_spreadsheet_and_schema_issue_flags', '20261005T0832_durable_after_pilot', ...sharedChain])
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
  // A failed returned reply is retained for diagnostics, then re-invoked by a
  // linked Retry using the same immutable capture and exact request.
  await owner.query("UPDATE extraction_runtime.head SET intent='RUN' WHERE id=$1",[extraction])
  const failedId=randomUUID()
  await invoke('capture_unit',[extraction,attempt,second.epoch,failedId,'record-2',{...descriptor,ordinal:1}])
  const failedInput=await invoke('finalize_input',[extraction,attempt,second.epoch,failedId,body])
  assert.equal(await invoke('begin_call',[extraction,attempt,second.epoch,failedId]),true)
  const failure={parsed:null,calls:[{ok:false,recovered:false,error:'invalid JSON'}]}
  await invoke('commit_output',[extraction,attempt,second.epoch,failedId,failedInput.digest,failure])
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM extraction_runtime.checkpoint WHERE id=$1',[failedId])).rows[0].n,0)
  assert.deepEqual((await invoke('read_call',[extraction,attempt,second.epoch,failedId])).checkpoint.output,failure)
  assert.equal((await owner.query('SELECT intent FROM extraction_runtime.head WHERE id=$1',[extraction])).rows[0].intent,'PAUSE')
  assert.equal(await invoke('capture_unit',[extraction,attempt,second.epoch,randomUUID(),'after-failure',{...descriptor,ordinal:2}]),null)
  assert.equal(await invoke('acknowledge',[extraction,attempt,second.epoch,false,{code:'incomplete_processing'}]),'FAILED')
  assert.equal(await invoke('read_attempt_outcome',[extraction,attempt]),'FAILED')
  const retry=randomUUID()
  await owner.query('INSERT INTO extraction_runtime.attempt (id,"extractionId","selectionId",fence,"workflowId") VALUES ($1,$2,$3,2,$4)',[retry,extraction,selection,`test:${retry}`])
  await owner.query(`UPDATE extraction_runtime.head SET "attemptId"=$2,fence=2,intent='RUN',acknowledgement='QUEUED',"leaseOwner"=NULL,"leaseUntil"=NULL WHERE id=$1`,[extraction,retry])
  const retryLease=await invoke('claim',[extraction,retry,randomUUID()])
  const retained=await invoke('read_call',[extraction,retry,retryLease.epoch,failedId])
  assert.equal(retained.checkpoint,null)
  assert.deepEqual(retained.input.request,body)
  assert.equal(retained.capture.originalAttemptId,attempt)
  assert.equal(await invoke('begin_call',[extraction,retry,retryLease.epoch,failedId]),true)
  await invoke('commit_output',[extraction,retry,retryLease.epoch,failedId,retained.input.digest,{parsed:{flag:false},calls:[{ok:true}]}])
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM extraction_runtime."callFailure" WHERE "captureId"=$1',[failedId])).rows[0].n,1)
  // Only output-limit failures supported by the pinned bounded planner may
  // continue. Committing admitted work never clears a researcher's intent.
  for (const policy of [
    {unified:true,stage:'discovery',finish:'length',intent:'RUN',recoverable:true},
    {unified:true,stage:'discovery',finish:'length',intent:'PAUSE',recoverable:true},
    {unified:true,stage:'entry',finish:'length',intent:'STOP',recoverable:true},
    {unified:false,stage:'discovery',finish:'length',intent:'RUN',recoverable:false},
    {unified:true,stage:'verify',finish:'length',intent:'RUN',recoverable:false},
    {unified:true,stage:'discovery',finish:'stop',intent:'RUN',recoverable:false},
    {unified:true,stage:'discovery',finish:null,intent:'RUN',recoverable:false},
    {unified:true,stage:'discovery',finish:'length',intent:'RUN',recoverable:false,mixed:true},
  ]) {
    const id=randomUUID(),selected=randomUUID(),active=randomUUID(),captureId=randomUUID()
    await owner.query(`INSERT INTO extraction_runtime.head
      (id,"projectId","sourceRevisionId","sourcePin",strategy,"selectionId",intent,"controlVersion","pendingResume",acknowledgement,"attemptId",fence,"leaseEpoch",generation,"snapshotVersion",deleted)
      VALUES ($1,$2,$3,$4,'CATALOG',$5,'RUN',0,false,'QUEUED',$6,1,0,1,0,false)`,
      [id,history.projectContextId,randomUUID(),{runId:'source',generation:'g1'},selected,active])
    await owner.query(`INSERT INTO extraction_runtime.selection (id,"extractionId",ordinal,"schemaRevisionId","schemaHash","schemaTree",method,resolved,digest)
      VALUES ($1,$2,1,$3,$4,$5,'{}','{}',$4)`,[selected,id,history.revisions.catalog,'a'.repeat(64),{recordDescription:'record',schemaNodes:[flagNode]}])
    await owner.query(`INSERT INTO extraction_runtime.attempt (id,"extractionId","selectionId",fence,"workflowId") VALUES ($1,$2,$3,1,$4)`,[active,id,selected,`test:${active}`])
    const lease=await invoke('claim',[id,active,randomUUID()])
    const configuration={models:{fields:provider,reasoning:provider},options:policy.unified?{unified:{defaults:1}}:{},planner:1,protocols:{calls:1,source:'records'}}
    await invoke('resolve_selection',[id,active,lease.epoch,configuration])
    const savedPlan=await invoke('publish_plan',[id,active,lease.epoch,randomUUID(),'record',
      {plannerVersion:1,selectionId:selected,sourceGeneration:'g1',units:[{key:'policy'}],coverage:{}}])
    await invoke('capture_unit',[id,active,lease.epoch,captureId,'policy',{...descriptor,planDigest:savedPlan.digest}])
    const frozen=await invoke('finalize_input',[id,active,lease.epoch,captureId,body])
    assert.equal(await invoke('begin_call',[id,active,lease.epoch,captureId]),true)
    await owner.query('UPDATE extraction_runtime.head SET intent=$2 WHERE id=$1',[id,policy.intent])
    const output={parsed:null,recoverable:true,calls:[{ok:false,stage:policy.stage,finish:policy.finish},
      ...(policy.mixed?[{ok:false,stage:'discovery',finish:'stop'}]:[])]}
    const committed=await invoke('commit_output',[id,active,lease.epoch,captureId,frozen.digest,output])
    assert.equal(committed.recoverable,policy.recoverable,JSON.stringify(policy))
    assert.deepEqual(await invoke('commit_output',[id,active,lease.epoch,captureId,frozen.digest,output]),committed)
    assert.equal((await invoke('read_call',[id,active,lease.epoch,captureId])).checkpoint.recoverable,policy.recoverable)
    assert.equal((await owner.query('SELECT intent FROM extraction_runtime.head WHERE id=$1',[id])).rows[0].intent,
      policy.recoverable?policy.intent:policy.intent==='STOP'?'STOP':'PAUSE')
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM extraction_runtime.checkpoint WHERE id=$1',[captureId])).rows[0].n,0)
    await assert.rejects(owner.query('UPDATE extraction_runtime."callFailure" SET recoverable=false WHERE "captureId"=$1',[captureId]),(e:{code?:string})=>e.code==='55000')
  }
  const denied = await owner.query(`SELECT has_schema_privilege('free_extraction_runtime', 'public', 'USAGE') AS allowed`)
  assert.equal(denied.rows[0].allowed, false)
})
