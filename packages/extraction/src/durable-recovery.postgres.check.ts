import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes,randomUUID } from 'node:crypto'
import { mkdtemp,writeFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { Client } from 'pg'
import { migrate,provisionDatabase,seedPreMigrationHistory,CATALOG_TREE } from '../../db/src/record-scope-history-fixture.js'
import { ensureKeiRole } from '../../db/src/kei-role.js'
import { initializeDurableExtraction } from './durable-repository.js'
import { durableTestNetwork } from './durable-test-network.js'

test('real worker processes recover captures, exact inputs and the app-commit/DBOS-ack gap',async t=>{
  const network=durableTestNetwork()
  const base=process.env.EXTRACTION_TEST_DATABASE_URL
  if(!base) throw new Error('Set EXTRACTION_TEST_DATABASE_URL to an explicit disposable free_test_* target.')
  const suffix=randomBytes(5).toString('hex')
  const target=await provisionDatabase(base,`free_test_durable_recovery_${suffix}`)
  const owner=new Client({connectionString:target.url}),role=`free_test_durable_recovery_${suffix}`
  const directory=await mkdtemp(resolve(tmpdir(),'free-durable-recovery-'))
  t.after(async()=>{
    await owner.end();await target.drop();await rm(directory,{recursive:true,force:true})
    const maintenanceUrl=new URL(base);maintenanceUrl.pathname='/postgres'
    const maintenance=new Client({connectionString:maintenanceUrl.toString()});await maintenance.connect()
    try{await maintenance.query(`DROP ROLE IF EXISTS ${role}`)}finally{await maintenance.end()}
  })
  await migrate(target.url);await owner.connect()
  const history=await seedPreMigrationHistory(owner)
  const password=randomBytes(24).toString('hex')
  await ensureKeiRole(owner,{role,password,schema:'kei_dbos'})
  const workerUrl=new URL(target.url);workerUrl.username=role;workerUrl.password=password
  const source=history.documents.d2
  const representation=(await owner.query('SELECT "preprocessId" FROM public."sourceRepresentationRevision" WHERE id=$1',[source.sourceRepresentationRevisionId])).rows[0]
  const cases=[]
  for(const fault of ['capture_unit','finalize_input','commit_output','saved_result','acknowledge']){
    const id=randomUUID()
    await owner.query(`INSERT INTO public.extraction (id,"sourceDocumentId","sourceRepresentationRevisionId","schemaRevisionId",strategy,"requestedSettings")
      VALUES ($1,$2,$3,$4,'CATALOG',$5)`,[id,source.sourceDocumentId,source.sourceRepresentationRevisionId,history.revisions.catalog,{generic:null}])
    await owner.query('BEGIN')
    try{await initializeDurableExtraction(owner as never,id,{projectContextId:history.projectContextId,
      sourceRepresentationRevisionId:source.sourceRepresentationRevisionId,schemaRevisionId:history.revisions.catalog,
      schemaTree:CATALOG_TREE,strategy:'CATALOG',catalogRecipe:null,preprocessId:representation.preprocessId,
      requestedModels:null,requestedSettings:{generic:null}});await owner.query('COMMIT')}
    catch(error){await owner.query('ROLLBACK');throw error}
    const head=(await owner.query('SELECT * FROM extraction_runtime.head WHERE id=$1',[id])).rows[0]
    const attempt=(await owner.query('SELECT "workflowId" FROM extraction_runtime.attempt WHERE id=$1',[head.attemptId])).rows[0]
    cases.push({fault,id,attempt:head.attemptId,workflow:attempt.workflowId,source:head.sourcePin})
  }
  await writeFile(resolve(directory,'fixture.json'),JSON.stringify({admin:target.url,worker:workerUrl.toString(),cases}),{mode:0o600})
  const root=resolve(import.meta.dirname,'../../..')
  const {stdout}=await promisify(execFile)('docker',['run','--rm','--network',network,'--entrypoint','sh',
    '-e','PYTHONDONTWRITEBYTECODE=1','-e','DURABLE_RECOVERY_FIXTURE=/fixture/fixture.json',
    '-v',`${root}/prototypes/parsing_service:/test:ro`,'-v',`${directory}:/fixture:ro`,'-w','/test',
    process.env.DURABLE_TEST_WORKER_IMAGE??'phoenix-tracing-parsing_worker','-c',
    'uv pip install --python /app/.venv/bin/python pytest==9.1.1 && /app/.venv/bin/python -m pytest -q --tb=short -o cache_dir=/tmp/pytest_cache tests/test_durable_workflow_recovery.py'],
    {timeout:240000,maxBuffer:1024*1024}).catch((error:{stdout?:string})=>{
      console.info(error.stdout?.split('\n').filter(line=>/^E\s|Error|FAILED|passed|failed/.test(line)).join('\n'))
      throw new Error('Guarded durable process-recovery matrix failed.')
    })
  assert.match(stdout,/5 passed/)
  console.info('All five guarded durable process-recovery faults passed.')
})
