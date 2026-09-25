import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const deps = createRequire(import.meta.url);
const {DBOS, DBOSClient} = deps('@dbos-inc/dbos-sdk');
const {Client} = deps('pg');
const root = process.env.FREE_REVIEW_ROOT;
assert.ok(root, 'Set FREE_REVIEW_ROOT to the FREE checkout');
const {validateDisposableTestDatabaseTarget} = await import(root+'/packages/db/src/database-url.ts');
const URL = 'postgresql://postgres:review-disposable-only@127.0.0.1:5432/free_test_dbos_review';
validateDisposableTestDatabaseTarget(URL);
const pg = new Client({connectionString:URL}); await pg.connect();
const mode = process.argv[2] ?? 'main';
DBOS.setConfig({name:'review',applicationVersion:'review@1',executorID:'review-'+mode,systemDatabaseUrl:URL,logLevel:'error',enableOTLP:false});
const admission = DBOS.registerWorkflow(async (id)=>DBOS.runStep(async()=>{
 const r=await pg.query('select id from admission_probe where id=$1',[id]);
 return r.rowCount ? 'completed' : 'not_admitted';
},{name:'waitForAdmission'}),{name:'admission'});
const saving = DBOS.registerWorkflow(async()=>DBOS.runStep(async()=>{
 const r=await pg.query('insert into revision_probe(revision) select coalesce(max(revision),0)+1 from revision_probe returning revision');
 if(r.rows[0].revision===1) process.kill(process.pid,'SIGKILL');
 return r.rows[0].revision;
},{name:'appendSchemaRevision'}),{name:'saving'});
const long = DBOS.registerWorkflow(async(v)=>{await DBOS.sleep(800);return v;},{name:'long'});
await DBOS.launch();
if(mode==='save') {
 const h=await DBOS.startWorkflow(saving,{workflowID:'save-crash'})();
 console.log('SAVE_RESULT',await h.getResult());
 await DBOS.shutdown();await pg.end();process.exit(0);
}
await pg.query('create table if not exists admission_probe(id text primary key); create table if not exists revision_probe(revision int primary key)');
await pg.query('delete from admission_probe');
await DBOS.deleteWorkflows(['admission-retry','dedup-a','dedup-b']);
const first=await DBOS.startWorkflow(admission,{workflowID:'admission-retry'})('job');
assert.equal(await first.getResult(),'not_admitted');
const second=await DBOS.startWorkflow(admission,{workflowID:'admission-retry'})('job');
await pg.query("insert into admission_probe values('job')");
console.log('ADMISSION_POISON',JSON.stringify({retryResult:await second.getResult(),rowExists:(await pg.query("select * from admission_probe where id='job'")).rowCount===1}));
await DBOS.registerQueue('dedup');
const a=await DBOS.startWorkflow(long,{workflowID:'dedup-a',queueName:'dedup',enqueueOptions:{deduplicationID:'same-revision'},duplicationPolicy:'return-existing'})('first');
const b=await DBOS.startWorkflow(long,{workflowID:'dedup-b',queueName:'dedup',enqueueOptions:{deduplicationID:'same-revision'},duplicationPolicy:'return-existing'})('second');
console.log('QUEUE_DEDUP',JSON.stringify({same:a.workflowID===b.workflowID,result:await b.getResult()}));
const requireDb = createRequire(root+'/packages/db/package.json');
const {default:postgres}=await import(requireDb.resolve('@prisma-next/postgres/runtime'));
const contractJson=JSON.parse(readFileSync(root+'/packages/db/src/prisma/contract.json','utf8'));
await pg.query('create table if not exists "researcherAccount"("id" uuid primary key,"tenantId" uuid not null,"objectId" uuid not null,"displayName" text not null,"createdAt" timestamptz not null,"updatedAt" timestamptz not null)');
const bound=new Client({connectionString:URL});await bound.connect();
const db=postgres({contractJson,pg:bound,verifyMarker:false});
const client=await DBOSClient.create({systemDatabaseUrl:URL});
for(const commit of [false,true]) {
 const id=randomUUID(); const wid='atomic-'+commit;
 try {
  await db.transaction(async({orm})=>{
   await orm.public.ResearcherAccount.create({id,tenantId:randomUUID(),objectId:randomUUID(),displayName:'synthetic',createdAt:new Date()});
   await client.enqueueInTransaction(bound,{workflowName:'admission',workflowID:wid,queueName:'unconsumed'},id);
   if(!commit) throw new Error('deliberate rollback');
  });
 } catch(e) {if(e.message!=='deliberate rollback') throw e;}
 const row=(await pg.query('select * from "researcherAccount" where id=$1',[id])).rowCount;
 const wf=await client.getWorkflow(wid);
 console.log('PRISMA_DBOS_ATOMIC',JSON.stringify({commit,row:!!row,workflow:!!wf}));
 assert.equal(!!row,commit);assert.equal(!!wf,commit);
}
await db.close(); await bound.end(); await client.destroy();await DBOS.shutdown();
function child(){return new Promise((resolve,reject)=>{const c=spawn(process.execPath,[import.meta.filename,'save'],{stdio:['ignore','pipe','pipe']});let out='';c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>out+=d);c.on('error',reject);c.on('exit',(code,signal)=>resolve({code,signal,out}));});}
console.log('CRASH_FIRST',JSON.stringify(await child()));
console.log('CRASH_RECOVER',JSON.stringify(await child()));
console.log('REVISION_REPLAY',JSON.stringify((await pg.query('select * from revision_probe order by revision')).rows));
await pg.end();
