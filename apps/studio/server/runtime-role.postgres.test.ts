import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DBOSClient } from '@dbos-inc/dbos-sdk'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ensureKeiRole } from 'db/kei-role'
import { ensureStudioRole } from 'db/studio-role'
import { spawnKeiStandIn, type KeiStandInProcess } from 'extraction/kei-stand-in-client'
import { migrate, provisionDatabase } from '../../../packages/db/src/record-scope-history-fixture.js'
import { runWorkflowChild } from '../test/support/crash.js'
import { disposableDatabaseUrl, testSchemas } from '../test/support/postgres.js'

/**
 * Studio's own paths on its restricted runtime role, prepared as Studio's entrypoint prepares it (db:roles): its DBOS
 * schema upgraded from one an earlier Studio created as postgres, a fresh DBOS schema, kei's workflows in tables kei
 * creates after the preparation, and domain, admission, review, deletion and garbage-collection writes on the domain
 * pool. The test migrates its own free_test_* database with unique roles and drops both when it ends.
 * packages/db/src/studio-role.postgres.check.ts proves what the role is denied.
 */
const suffix = randomBytes(4).toString('hex')
// One runtime role per DBOS schema, as in production: the upgraded schema's and a fresh schema's.
const roles = { studio: `free_test_studio_${suffix}`, fresh: `free_test_fresh_${suffix}`, kei: `free_test_kei_${suffix}` }
const passwords = { studio: randomBytes(24).toString('hex'), fresh: randomBytes(24).toString('hex'), kei: randomBytes(24).toString('hex') }
const upgraded = testSchemas()
const fresh = testSchemas()
const keiSchema = upgraded.keiSchema
const scratch = mkdtempSync(join(tmpdir(), 'free-runtime-role-'))
const CONTRACTS = new URL('../../parsing_service/tests/fixtures/contracts/', import.meta.url)

let target: Awaited<ReturnType<typeof provisionDatabase>>
let admin: pg.Client
let runtimeUrl: string
let standIn: KeiStandInProcess | undefined
let stopStudio: (() => Promise<void>) | undefined

const urlAs = (role: string, password: string) => {
  const url = new URL(target.url)
  url.username = role
  url.password = password
  return url.toString()
}
const ownersOf = async (schema: string) => (await admin.query<{ owner: string }>(
  `SELECT DISTINCT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relnamespace = $1::text::regnamespace
   UNION SELECT DISTINCT pg_get_userbyid(proowner) FROM pg_proc WHERE pronamespace = $1::text::regnamespace`,
  [schema])).rows.map((row) => row.owner)
async function eventually<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 60_000
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${what}.`)
    await delay(100)
  }
}

beforeAll(async () => {
  target = await provisionDatabase(disposableDatabaseUrl(), `free_test_runtime_role_${suffix}`)
  await migrate(target.url)
  admin = new pg.Client({ connectionString: target.url })
  await admin.connect()

  // An earlier Studio ran as postgres and was killed mid-workflow: its DBOS objects and the pending workflow's history
  // are postgres's.
  const history = { DATABASE_URL: target.url, FREE_TEST_DBOS_SCHEMA: upgraded.schema, FREE_TEST_KEI_SCHEMA: keiSchema,
    FREE_TEST_EXECUTOR: upgraded.executorId, FREE_CRASH_MARKER: join(scratch, 'upgrade-marker'),
    FREE_TEST_LIFECYCLE_FILE: join(scratch, 'upgrade-steps.txt') }
  expect((await runWorkflowChild('lifecycle', history)).signal).toBe('SIGKILL')
  expect(await ownersOf(upgraded.schema)).toEqual(['postgres'])

  // What `db:roles` does at every Studio start, twice: a restart prepares the same roles again.
  for (let start = 0; start < 2; start++) {
    await ensureKeiRole(admin, { role: roles.kei, schema: keiSchema, password: passwords.kei })
    await ensureStudioRole(admin, { role: roles.studio, schema: upgraded.schema, keiRole: roles.kei, keiSchema, password: passwords.studio })
    await ensureStudioRole(admin, { role: roles.fresh, schema: fresh.schema, keiRole: roles.kei, keiSchema, password: passwords.fresh })
  }

  // kei migrates kei_dbos once Studio is healthy, so its tables are created after the preparation. This stand-in is
  // TypeScript DBOS, whose first migration needs CREATE on the database even for kei's existing schema (Python DBOS,
  // kei in production, checks first); it holds that only while it launches.
  await admin.query(`GRANT CREATE ON DATABASE "${new URL(target.url).pathname.slice(1)}" TO ${roles.kei}`)
  try {
    standIn = await spawnKeiStandIn({ databaseUrl: urlAs(roles.kei, passwords.kei), schema: keiSchema })
  } finally {
    await admin.query(`REVOKE CREATE ON DATABASE "${new URL(target.url).pathname.slice(1)}" FROM ${roles.kei}`)
  }
  expect(await ownersOf(keiSchema)).toEqual([roles.kei])

  // The upgraded Studio, now the runtime role, recovers the workflow the earlier one left pending.
  runtimeUrl = urlAs(roles.studio, passwords.studio)
  const recovered = await runWorkflowChild('lifecycle', { ...history, DATABASE_URL: runtimeUrl })
  expect(recovered.code, recovered.output).toBe(0)

  // Studio itself: the domain pool binds DATABASE_URL at import, so the runtime URL is set first.
  process.env.DATABASE_URL = runtimeUrl
  const { db, pool } = await import('db')
  const { launchStudioDbos, shutdownStudioDbos } = await import('./dbos.js')
  const { applyStudioSchedules, registerStudioWorkflows } = await import('./workflows.js')
  const { garbagePorts } = await import('../api/_garbage_workflow.js')
  const { createCanonicalPackageStore } = await import('../../../packages/db/src/artifact-store.js')
  const { listStagedSources, removeStagedSource } = await import('../api/_source_inbox.js')
  stopStudio = async () => {
    try { await shutdownStudioDbos() } finally { await db.close(); await pool.end() }
  }
  await launchStudioDbos({
    databaseUrl: runtimeUrl, ...upgraded,
    register: () => registerStudioWorkflows({ garbagePorts: () => garbagePorts({
      packages: createCanonicalPackageStore(join(scratch, 'packages')),
      inbox: { root: join(scratch, 'inbox'), list: listStagedSources, remove: removeStagedSource },
    }) }),
    schedule: applyStudioSchedules,
  })
})

afterAll(async () => {
  const failures: unknown[] = []
  for (const step of [() => stopStudio?.(), () => standIn?.stop(), () => admin?.end(), () => target?.drop()])
    await Promise.resolve().then(step).catch((error: unknown) => failures.push(error))
  // The database held every grant, default privilege and object of the roles, so they are unused once it is gone.
  const maintenance = new URL(target.url)
  maintenance.pathname = '/postgres'
  const cluster = new pg.Client({ connectionString: maintenance.toString() })
  await cluster.connect()
  try {
    for (const role of [roles.studio, roles.fresh, roles.kei])
      await cluster.query(`DROP ROLE IF EXISTS ${role}`).catch((error: unknown) => failures.push(error))
  } finally {
    await cluster.end()
  }
  rmSync(scratch, { recursive: true, force: true })
  if (failures.length > 0) throw new AggregateError(failures, 'Runtime role test cleanup failed.')
})

describe('Studio on its restricted runtime role', () => {
  it('connects as that role, which owns the upgraded DBOS schema and finished the workflow left pending there', async () => {
    const { pool } = await import('db')
    const session = (await pool.query('SELECT current_user AS role, rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0]
    expect(session).toEqual({ role: roles.studio, rolsuper: false })
    expect(await ownersOf(upgraded.schema)).toEqual([roles.studio])
    const { studioDbos } = await import('./dbos.js')
    expect((await studioDbos().admission.getWorkflow('lifecycle-probe'))?.status).toBe('SUCCESS')
    const steps = await admin.query(`SELECT count(*)::int AS n FROM ${upgraded.schema}.operation_outputs WHERE workflow_uuid = 'lifecycle-probe'`)
    expect(steps.rows[0].n).toBe(3)
    // Step a ran once, under postgres; b, killed there, ran again under the runtime role, then c.
    expect(readFileSync(join(scratch, 'upgrade-steps.txt'), 'utf8').split('\n').filter(Boolean))
      .toEqual(['a', 'b-start', 'b-start', 'b-end', 'c'])
  })

  it('migrates a fresh DBOS schema, enqueues and recovers a killed workflow as that role', async () => {
    const file = join(scratch, 'fresh-steps.txt')
    const env = { DATABASE_URL: urlAs(roles.fresh, passwords.fresh), FREE_TEST_DBOS_SCHEMA: fresh.schema, FREE_TEST_KEI_SCHEMA: keiSchema,
      FREE_TEST_EXECUTOR: fresh.executorId, FREE_CRASH_MARKER: join(scratch, 'fresh-marker'), FREE_TEST_LIFECYCLE_FILE: file }
    const killed = await runWorkflowChild('lifecycle', env)
    expect(killed.signal, killed.output).toBe('SIGKILL')
    const recovered = await runWorkflowChild('lifecycle', env)
    expect(recovered.code, recovered.output).toBe(0)
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toEqual(['a', 'b-start', 'b-start', 'b-end', 'c'])
    expect(await ownersOf(fresh.schema)).toEqual([roles.fresh])
  })

  it('submits, lists, cancels and deletes kei workflows in the tables kei created after the preparation', async () => {
    const { studioDbos } = await import('./dbos.js')
    const { createKeiHandoff, keiConvertWorkflowId } = await import('extraction/kei-handoff')
    const handoff = createKeiHandoff(studioDbos().kei)
    const { enqueue, request } = JSON.parse(readFileSync(new URL('convert.input.json', CONTRACTS), 'utf8'))
    await standIn!.policy({ convert: 'hold' })
    const workflowId = keiConvertWorkflowId(`ingest:${randomUUID()}:${randomUUID()}`)
    await handoff.submitConversion({ workflowId, lane: enqueue.queue_name, pageCount: 3, request, owner: 'runtime-role@example.test',
      attributes: { projectContextId: randomUUID() } })
    await eventually(async () => (await standIn!.held()).some((work) => work.workflowId === workflowId) || undefined,
      'kei holds the conversion')
    expect((await studioDbos().kei.listWorkflows({ workflowIDs: [workflowId] }))[0]?.status).toBe('PENDING')
    await handoff.cancel(workflowId)
    expect((await studioDbos().kei.listWorkflows({ workflowIDs: [workflowId] }))[0]?.status).toBe('CANCELLED')
    await studioDbos().kei.deleteWorkflow(workflowId)
    expect(await studioDbos().kei.listWorkflows({ workflowIDs: [workflowId] })).toEqual([])
  })

  it('writes the domain, admits and reviews an Extraction, deletes its Project and sweeps garbage as that role', async () => {
    const { createResearcherProjectStore, workflowStatusesOf } = await import('db')
    const { seedResearch } = await import('../test/support/research.js')
    const { createResearcherExtractions } = await import('../api/_extractions.js')
    const { cancelScopeWork } = await import('../api/_scope_cancellation.js')
    const { collectGarbageNow } = await import('./collectGarbageNow.js')
    const { studioDbos } = await import('./dbos.js')
    const { createDurableRepository, initializeDurableExtraction } = await import('../../../packages/extraction/src/durable-repository.js')
    const { createCanonicalPackageStore } = await import('../../../packages/db/src/artifact-store.js')

    // Domain writes through the ORM, as ingestion and the project routes make them.
    const seeded = await seedResearch(createCanonicalPackageStore(join(scratch, 'packages')))
    const store = createResearcherProjectStore(seeded.researcherAccountId, undefined, {
      workflowStatuses: (ids) => workflowStatusesOf((input) => studioDbos().admission.listWorkflows(input))(ids),
    })
    const spare = await store.createProjectContext('Runtime role spare')
    expect((await store.renameProjectContext(spare.projectContextId, 'Runtime role renamed'))?.name).toBe('Runtime role renamed')
    expect(await store.deleteProjectContext(spare.projectContextId)).toBe(true)

    // Admission commits the Extraction, its durable head and its workflow in Studio's DBOS schema in one transaction;
    // the admitted workflow then dispatches the attempt into kei_dbos.
    const extractionId = randomUUID()
    await createResearcherExtractions(seeded.researcherAccountId).runSingle({
      kind: 'fresh', extractionId, sourceRepresentationRevisionId: seeded.sourceRepresentationRevisionId,
      schemaRevisionId: seeded.schemaRevisionId, strategy: 'ARTICLE', method: { models: null, settings: { article: null } },
    })
    const attempt = await eventually(async () => (await studioDbos().kei.listWorkflows({
      workflowName: 'extractDurableV1', loadInput: false, loadOutput: false })).find(() => true), 'kei has the attempt')
    expect(attempt.applicationName).toBe('kei')

    // Review on a completed Extraction of the same document: the durable repository writes extraction_runtime directly.
    const reviewed = randomUUID()
    const tree = { recordDescription: 'One page record.', schemaNodes: [{ id: 'title', name: 'title', type: 'string' }] }
    const preprocessId = `kei-exp:${seeded.runId}:${seeded.generation}`
    await admin.query(`INSERT INTO public.extraction (id,"sourceDocumentId","sourceRepresentationRevisionId","schemaRevisionId",strategy,"requestedSettings")
      VALUES ($1,$2,$3,$4,'ARTICLE',$5)`, [reviewed, seeded.sourceDocumentId, seeded.sourceRepresentationRevisionId, seeded.schemaRevisionId, { article: null }])
    await admin.query('BEGIN')
    await initializeDurableExtraction(admin as never, reviewed, { projectContextId: seeded.projectContextId,
      sourceRepresentationRevisionId: seeded.sourceRepresentationRevisionId, schemaRevisionId: seeded.schemaRevisionId,
      schemaTree: tree, strategy: 'ARTICLE', catalogRecipe: null, preprocessId, requestedModels: null, requestedSettings: { article: null } })
    await admin.query('COMMIT')
    const head = (await admin.query('SELECT "selectionId" FROM extraction_runtime.head WHERE id=$1', [reviewed])).rows[0]
    const value = { id: 'title', recordId: 'record', fieldId: 'title', path: ['records', 0, 'title'], selectionId: head.selectionId,
      schemaRevisionId: seeded.schemaRevisionId, node: tree.schemaNodes[0], modelValue: 'A title', evidence: [],
      grounding: 'ungrounded', processing: 'saved', lineage: [] }
    await admin.query(`INSERT INTO extraction_runtime.snapshot (id,"extractionId",version,"selectionId",digest,values,coverage)
      VALUES ($1,$2,1,$3,$4,$5,$6)`, [randomUUID(), reviewed, head.selectionId, 'a'.repeat(64), JSON.stringify([value]),
      { diagnostics: { evidence: [], ungrounded: [] }, processingComplete: true }])
    await admin.query(`UPDATE extraction_runtime.head SET "snapshotVersion"=1,acknowledgement='COMPLETED' WHERE id=$1`, [reviewed])
    const repository = createDurableRepository(seeded.researcherAccountId)
    await repository.saveCorrection(reviewed, 'title', { snapshotVersion: 1, expectedRevision: 0, action: 'APPROVED',
      value: 'A title', included: true, evidence: [] }, async () => {})
    const page = await repository.page(reviewed)
    expect(page.reviewCounts.approved).toBe(1)
    await repository.finalize(reviewed, { snapshotVersion: 1, feedbackVersion: page.feedbackVersion })

    // Deleting the Project removes its graph (the durable delete fence fires) and stops its live work in both schemas.
    expect(await store.deleteProjectContext(seeded.projectContextId)).toBe(true)
    // Cancellation reports a failed list or cancel only as a warning, so a warning here is a denied privilege.
    const warn = vi.spyOn(console, 'warn')
    await cancelScopeWork({ projectContextId: seeded.projectContextId })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    expect((await admin.query('SELECT count(*)::int AS n FROM public.extraction WHERE id = ANY($1)', [[extractionId, reviewed]])).rows[0].n).toBe(0)

    // gc:now through its own DBOS client, as an operator runs it inside the Studio container.
    const create = ((options: Parameters<typeof DBOSClient.create>[0]) =>
      DBOSClient.create({ ...options, systemDatabaseSchemaName: upgraded.schema })) as typeof DBOSClient.create
    expect((await collectGarbageNow(runtimeUrl, create)).summary.failedPhases).toEqual([])
  })
})
