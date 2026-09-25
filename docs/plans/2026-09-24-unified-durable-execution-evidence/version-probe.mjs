// Checks the two behaviours the plan relies on after the 5.1.10 / 0.4.4 pin bump:
// (1) what a successful durableCalls stream still checkpoints, and
// (2) whether DBOS.stepStatus.cancelSignal reaches code inside a durableCalls step.
import assert from 'node:assert/strict';
import {DBOS} from '@dbos-inc/dbos-sdk';
import {durableCalls} from '@dbos-inc/vercel-ai';
import {wrapLanguageModel} from 'ai';
import {Client} from 'pg';
const root = process.env.FREE_REVIEW_ROOT;
if (!root) throw new Error('Set FREE_REVIEW_ROOT to the FREE checkout');
const {validateDisposableTestDatabaseTarget}=await import(root+'/packages/db/src/database-url.ts');
const url='postgresql://postgres:review-disposable-only@127.0.0.1:5432/free_test_dbos_version';validateDisposableTestDatabaseTarget(url);
const pg=new Client({connectionString:url});await pg.connect();
DBOS.setConfig({name:'version-review',applicationVersion:'version-review@1',executorID:'version-review',systemDatabaseUrl:url,logLevel:'error',enableOTLP:false});
const DOC='SYNTHETIC_DOCUMENT_BODY',HEADER='SYNTHETIC_HEADER_SECRET',META='SYNTHETIC_PROVIDER_METADATA';
const usage={inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}};
const synthetic=(doStream)=>({specificationVersion:'v4',provider:'synthetic',modelId:'synthetic',supportedUrls:{},doGenerate:async()=>{throw Error('unused');},doStream});
const okModel=wrapLanguageModel({model:synthetic(async()=>({
 request:{body:{prompt:DOC}},response:{headers:{'x-synthetic':HEADER}},
 stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'text-start',id:'x'});c.enqueue({type:'text-delta',id:'x',delta:'answer'});c.enqueue({type:'text-end',id:'x'});c.enqueue({type:'finish',finishReason:{unified:'stop',raw:'stop'},usage,providerMetadata:{synthetic:{marker:META}}});c.close();}}),
})),middleware:durableCalls({name:'chat',durableStream:'ui'})});
const okTurn=DBOS.registerWorkflow(async()=>{const r=await okModel.doStream({prompt:[]});for await(const _ of r.stream){}return 'ok';},{name:'okTurn'});
let waitEntered,providerCallsAfterWait=0;const entered=new Promise(r=>{waitEntered=r;});
const waitModel=wrapLanguageModel({model:synthetic(async()=>{
 const signal=DBOS.stepStatus?.cancelSignal;waitEntered();
 const fired=await new Promise(r=>{if(!signal) return r(false);if(signal.aborted) return r(true);signal.addEventListener('abort',()=>r(true),{once:true});setTimeout(()=>r(false),10000);});
 globalThis.waitResult={hadSignal:!!signal,fired,firedAt:Date.now()};
 if(fired) throw Object.assign(new Error('model_key_required'),{isRetryable:false});
 providerCallsAfterWait++;throw new Error('provider reached');
}),middleware:durableCalls({name:'chat'})});
const waitTurn=DBOS.registerWorkflow(async()=>{const r=await waitModel.doStream({prompt:[]});for await(const _ of r.stream){}return 'unreachable';},{name:'waitTurn'});
await DBOS.launch();
const ok=await DBOS.startWorkflow(okTurn,{workflowID:'version-ok'})();assert.equal(await ok.getResult(),'ok');
const tables=(await pg.query("select table_name from information_schema.tables where table_schema='dbos'")).rows.map(r=>r.table_name);
const found={};for(const m of [DOC,HEADER,META]){found[m]=[];for(const t of tables){const n=(await pg.query(`select count(*)::int n from dbos."${t}" x where x::text like $1`,['%'+m+'%'])).rows[0].n;if(n) found[m].push(t);}}
console.log('SUCCESS_CHECKPOINT',JSON.stringify({requestBodyIn:found[DOC],responseHeaderIn:found[HEADER],providerMetadataIn:found[META]}));
const waiting=await DBOS.startWorkflow(waitTurn,{workflowID:'version-cancel'})();await entered;
const cancelAt=Date.now();await DBOS.cancelWorkflow('version-cancel');
try{await waiting.getResult();}catch(e){globalThis.outcome=e.constructor.name;}
await new Promise(r=>setTimeout(r,200));
const {firedAt,...wait}=globalThis.waitResult??{};
console.log('CANCEL_SIGNAL',JSON.stringify({...wait,cancelToSignalMs:firedAt?firedAt-cancelAt:null,providerCallsAfterWait,outcome:globalThis.outcome,status:(await DBOS.getWorkflowStatus('version-cancel'))?.status}));
assert.equal(globalThis.waitResult.fired,true);assert.equal(providerCallsAfterWait,0);
await DBOS.shutdown();await pg.end();
