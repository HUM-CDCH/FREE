import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const root = process.env.FREE_REVIEW_ROOT;
if (!root) throw new Error('Set FREE_REVIEW_ROOT to the FREE checkout');
const {validateDisposableTestDatabaseTarget}=await import(root+'/packages/db/src/database-url.ts');
process.env.DATABASE_URL='postgresql://postgres:review-disposable-only@127.0.0.1:5432/free_test_dbos_fk';
validateDisposableTestDatabaseTarget(process.env.DATABASE_URL);
const {db}=await import(root+'/packages/db/src/prisma/db.ts');
const {createResearcherProjectStore}=await import(root+'/packages/db/src/project-store.ts');
const account=await db.orm.public.ResearcherAccount.create({tenantId:randomUUID(),objectId:randomUUID(),displayName:'synthetic'});
const store=createResearcherProjectStore(account.id,db);
const project=await store.createProjectContext('synthetic');
const doc=await db.orm.public.SourceDocument.create({projectContextId:project.projectContextId,ingestionKey:randomUUID(),contentSha256:'a'.repeat(64),mediaType:'application/pdf'});
const rep=await db.orm.public.SourceRepresentationRevision.create({sourceDocumentId:doc.id,revisionNumber:1,artifactReference:'a'.repeat(64),artifactSha256:'a'.repeat(64),contractVersion:'1',preprocessId:'synthetic',parserName:'kei-exp',parserVersion:'5'});
const batch=await db.orm.public.BatchSchemaSuggestion.create({projectContextId:project.projectContextId,selectionKey:randomUUID()});
await db.orm.public.BatchSchemaSuggestionSource.create({batchSchemaSuggestionId:batch.id,sourceDocumentId:doc.id,sourceRepresentationRevisionId:rep.id});
try { await store.deleteSourceDocument(project.projectContextId,doc.id);console.log('BATCH_SOURCE_DELETE unexpectedly succeeded'); }
catch(e) {console.log('BATCH_SOURCE_DELETE',JSON.stringify({code:e.sqlState,constraint:e.constraint,message:e.message}));assert.equal(e.sqlState,'23503');}
await db.close();
