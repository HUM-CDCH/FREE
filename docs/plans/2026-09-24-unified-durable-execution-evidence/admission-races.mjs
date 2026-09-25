import assert from 'node:assert/strict';
import {Client} from 'pg';
import {DBOS,DBOSClient} from '@dbos-inc/dbos-sdk';
const root = process.env.FREE_REVIEW_ROOT;
if (!root) throw new Error('Set FREE_REVIEW_ROOT to the FREE checkout');
const {validateDisposableTestDatabaseTarget}=await import(root+'/packages/db/src/database-url.ts');
const url='postgresql://postgres:review-disposable-only@127.0.0.1:5432/free_test_dbos_races';
validateDisposableTestDatabaseTarget(url);
DBOS.setConfig({name:'review-races',applicationVersion:'review@1',executorID:'review-races',systemDatabaseUrl:url,logLevel:'error',enableOTLP:false});
await DBOS.launch();
const c=await DBOSClient.create({systemDatabaseUrl:url});
const control=new Client({connectionString:url});await control.connect();
await control.query('create table admission_probe(id text primary key, question text not null)');
async function admit(id,dedup,question) {
 const pg=new Client({connectionString:url});await pg.connect();
 try {
  await pg.query('begin');
  await pg.query('insert into admission_probe values($1,$2)',[id,question]);
  await c.enqueueInTransaction(pg,{workflowName:'not-consumed',workflowID:id,queueName:'unconsumed-review',deduplicationID:dedup},id);
  await pg.query('commit');return {id,action:'created'};
 } catch(e) {
  await pg.query('rollback');
  if(e.code==='23505' && e.constraint==='admission_probe_pkey') {
   const r=await pg.query('select question from admission_probe where id=$1',[id]);
   return {id,action:r.rows[0]?.question===question?'replayed':'conflict'};
  }
  return {id,action:'rejected',error:e.constructor.name,message:e.message};
 } finally {await pg.end();}
}
const same=await Promise.all([admit('same','same-revision','question'),admit('same','same-revision','question')]);
assert.deepEqual(same.map(r=>r.action).sort(),['created','replayed']);
console.log('SAME_TURN_RACE',JSON.stringify(same));
const different=await Promise.all([admit('different-a','other-revision','a'),admit('different-b','other-revision','b')]);
assert.deepEqual(different.map(r=>r.action).sort(),['created','rejected']);
const rows=await control.query("select id from admission_probe where id like 'different-%'");
assert.equal(rows.rowCount,1);
console.log('DIFFERENT_TURN_RACE',JSON.stringify({results:different,persistedQuestions:rows.rowCount}));
const before=Number((await control.query("select extract(epoch from clock_timestamp())*1000 as ms")).rows[0].ms);
await new Promise(r=>setTimeout(r,10));
await c.cancelWorkflow('same');
const st=await c.getWorkflow('same');
const cancel=await control.query("select status,updated_at,deduplication_id from dbos.workflow_status where workflow_uuid='same'");
assert.equal(st.status,'CANCELLED');assert.ok(Number(cancel.rows[0].updated_at)>=before);
const next=await admit('same-after-cancel','same-revision','next');assert.equal(next.action,'created');
console.log('CANCEL_RELEASE',JSON.stringify({status:st.status,cancelUpdatesTimestamp:true,dedupCleared:cancel.rows[0].deduplication_id===null,newAdmission:next.action}));
await c.destroy();await DBOS.shutdown();await control.end();
