const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { existsSync, symlinkSync } = require('node:fs');
const root = __dirname;
const requireStudio = createRequire('/home/gebbaro/Progetti/FREE/prototypes/studio/package.json');
if (!existsSync(root+'/node_modules')) symlinkSync('/home/gebbaro/Progetti/FREE/prototypes/studio/node_modules',root+'/node_modules','dir');
const paths = ['place','year'].map(name=>['records',0,name]);
const pending = paths.map((resultPath,i)=>({resultPath,evidenceAnchorId:'anchor-'+i,reviewedOccurrenceIds:['occurrence-'+i],action:'APPROVED',reviewedValue:null}));
const ungrounded = Array.from({length:24},(_,i)=>['records',0,'unverified_'+i]);
const attempt = {
 extractionId:'11111111-1111-4111-8111-111111111111',sourceDocumentId:'44444444-4444-4444-8444-444444444444',
 sourceRepresentationRevisionId:'22222222-2222-4222-8222-222222222222',schemaRevisionId:'33333333-3333-4333-8333-333333333333',
 strategy:'ARTICLE',catalogRecipe:null,executionStatus:'COMPLETED',outcome:'SUCCEEDED',complete:false,
 modelAttribution:{provider:'ollama',modelId:'fixture'},diagnostics:{phase:'grounding',durationMs:1,modelCalls:0,finishReason:null,inputTokens:null,outputTokens:null,
 grounding:{groundedPaths:paths,ungroundedPaths:ungrounded,issueCodes:[],batches:[]},catalog:null},failure:null,
 resultPayload:{records:[{place:'Copenhagen',year:2000,...Object.fromEntries(ungrounded.map((path,i)=>[path[2],'Value '+i]))}]},
 evidenceLinks:pending.map(({resultPath,evidenceAnchorId})=>({resultPath,evidenceAnchorId})),reviewable:true,batchExtractionId:null,
 createdAt:'2026-10-01T12:00:00.000Z',reviewedAt:null,reviewDecisions:[],
};
let draft={version:0,decisions:[]};
(async()=>{
 const {createServer}=await import(pathToFileURL(requireStudio.resolve('vite')).href);
 const react=(await import(pathToFileURL(requireStudio.resolve('@vitejs/plugin-react')).href)).default;
 const tailwind=(await import(pathToFileURL(requireStudio.resolve('@tailwindcss/vite')).href)).default;
 const server=await createServer({configFile:false,root,cacheDir:root+'/.cache',plugins:[react(),tailwind(),{
  name:'controlled-review-responses',configureServer(server){server.middlewares.use(async(req,res,next)=>{
   if (!req.url.startsWith('/api/') && req.url!='/fixture/attempt') return next();
   res.setHeader('Content-Type','application/json');
   if (req.url==='/fixture/attempt') return res.end(JSON.stringify(attempt));
   if (req.method==='GET') return res.end(JSON.stringify({extraction:attempt,pendingReviewDecisions:pending,reviewDraft:draft}));
   let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);
   await new Promise(resolve=>setTimeout(resolve,150));
   if (req.url.endsWith('/draft')) {draft={version:draft.version+1,decisions:input.decisions};return res.end(JSON.stringify(draft));}
   attempt.reviewedAt=new Date().toISOString();attempt.reviewDecisions=input.reviewDecisions.map(decision=>({...decision,createdAt:attempt.reviewedAt}));
   res.end(JSON.stringify(attempt));
  })},
 }],server:{host:'127.0.0.1',port:48792,strictPort:true,fs:{allow:[root,'/home/gebbaro/Progetti/FREE']}}});
 await server.listen();console.log('Review fixture ready at http://127.0.0.1:48792');
 process.on('SIGINT',async()=>{await server.close();process.exit(0)});
})().catch(error=>{console.error(error);process.exit(1)});
