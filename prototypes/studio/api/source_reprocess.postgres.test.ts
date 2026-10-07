import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { db, pool, type ResearcherProjectStore } from 'db'
import { dbosSteps } from 'extraction'
import { createKeiHandoff, KEI_APPLICATION, type KeiConvertInput } from 'extraction/kei-handoff'
import { spawnKeiStandIn, type KeiStandInProcess } from 'extraction/kei-stand-in-client'
import { createCanonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import { launchStudioDbos, shutdownStudioDbos, studioDbos } from '../server/dbos.js'
import { awaitWorkflowOutcome } from '../server/workflowOutcome.js'
import { runWorkflowChild } from '../test/support/crash.js'
import { chooseIngestionModels, ingestionStoreFor, removeOwner, seedOwner, uploadRequest } from '../test/support/ingestion.js'
import { blankPdf } from '../test/support/pdf.js'
import { disposableDatabaseUrl, dropSchemas, testSchemas } from '../test/support/postgres.js'
import { registerIngestionWorkflow, type IngestionOutcome } from './_ingestion_workflow.js'
import { registerReprocessWorkflow } from './_reprocess_workflow.js'
import { createSourceDocumentIngestion } from './source_documents.js'
import { createSourceDocumentReprocessing } from './source_reprocess.js'

const url = disposableDatabaseUrl()
const scratch = mkdtempSync(join(tmpdir(), 'free-source-reprocess-'))
const inbox = join(scratch, 'source-inbox')
mkdirSync(inbox)
const packages = createCanonicalPackageStore(join(scratch, 'packages'))
const schemas = testSchemas()
const dropped = [schemas.schema, schemas.keiSchema]
const owners: string[] = []
let standIn: KeiStandInProcess
let kei: DBOSClient

beforeAll(async () => {
  standIn = await spawnKeiStandIn({ databaseUrl: url, schema: schemas.keiSchema })
  kei = await DBOSClient.create({ systemDatabaseUrl: url, systemDatabaseSchemaName: schemas.keiSchema, applicationName: KEI_APPLICATION })
  await launchStudioDbos({ databaseUrl: url, ...schemas, register: () => {
    const ports = () => ({ steps: dbosSteps, kei: createKeiHandoff(studioDbos().kei, { pollIntervalMs: 100 }),
      readBase: standIn.url, inboxRoot: inbox, packageStore: packages, storeFor: ingestionStoreFor(packages) })
    registerIngestionWorkflow(ports)
    registerReprocessWorkflow(ports)
  } })
})

afterEach(async () => {
  await standIn.policy({ convert: 'auto' })
  for (const work of await standIn.held()) await standIn.answer(work.workflowId, { convert: 'auto' })
})

afterAll(async () => {
  try {
    await shutdownStudioDbos()
    await standIn?.stop()
    await kei?.destroy()
    for (const owner of owners) await removeOwner(owner)
  } finally {
    try { await dropSchemas(url, ...dropped) }
    finally { await db.close(); await pool.end(); rmSync(scratch, { recursive: true, force: true }) }
  }
})

const until = (check: () => Promise<void>) => vi.waitFor(check, { timeout: 60_000, interval: 50 })
const request = (project: string, document: string, head: string, key = randomUUID()) => new Request(
  `http://test/api/project-contexts/${project}/source-documents/${document}/reprocess`,
  { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestKey: key, expectedRepresentationId: head, layout: 'pages' }) },
)
const post = (store: ResearcherProjectStore, req: Request, timeoutMs = 30_000) =>
  createSourceDocumentReprocessing(store, { readPackage: packages.read, resultPollIntervalMs: 50, resultTimeoutMs: timeoutMs })(req)

async function fixture() {
  const { owner, store } = await seedOwner()
  owners.push(owner)
  const project = (await store.createProjectContext(`Reprocess ${randomUUID()}`)).projectContextId
  const pdf = blankPdf(3, randomUUID())
  const admitted = await createSourceDocumentIngestion(store, { inboxRoot: inbox, packageStore: packages })(uploadRequest(project, pdf))
  expect(admitted.status, await admitted.clone().text()).toBe(202)
  // The upload answers on admission; the fixture waits for the document it becomes.
  const { workflowId } = await admitted.json() as { workflowId: string }
  const outcome = await awaitWorkflowOutcome<IngestionOutcome>(studioDbos().admission, workflowId, { timeoutMs: 60_000, intervalMs: 50 })
  if (outcome.state !== 'finished' || !outcome.output.ok) throw new Error(`The fixture upload ended ${JSON.stringify(outcome)}.`)
  const { sourceDocument: { sourceDocumentId: document, sourceRepresentationId: head }, pageCount } = outcome.output
  // The stand-in's fixture parse records eight physical pages, though the staged test PDF has three.
  // Reprocessing must choose its lane from this stored count.
  expect(pageCount).toBe(8)
  return { owner, store, project, pdf, document, head }
}

const workflow = (document: string, key: string) => `reprocess:${document}:${key}`
const child = (document: string, key: string) => `kei-convert:${workflow(document, key)}`

describe('reprocessSource on PostgreSQL', () => {
  it("converts on the stored page count's lane and freezes the owner's current model choice", async () => {
    const { owner, store, project, document, head } = await fixture()
    await chooseIngestionModels(owner, { ocr: 'first-ocr', layout: 'first-layout' })
    const key = randomUUID()
    const response = await post(store, request(project, document, head, key))
    expect(response.status, await response.clone().text()).toBe(201)
    const [converted] = await kei.listWorkflows({ workflowIDs: [child(document, key)], loadInput: true })
    expect(converted?.queueName).toBe('kei-convert-small')
    expect((converted?.input?.[0] as KeiConvertInput)).toMatchObject({ model: 'first-ocr', layout_model: 'first-layout' })
    const [admitted] = await studioDbos().admission.listWorkflows({ workflowIDs: [workflow(document, key)], loadInput: true })
    expect(admitted?.input?.[0]).toMatchObject({ pageCount: 8, lane: 'kei-convert-small' })
    const newHead = (await response.json() as { sourceRepresentationId: string }).sourceRepresentationId
    await chooseIngestionModels(owner, { ocr: 'second-ocr', layout: 'second-layout' })
    const nextKey = randomUUID()
    expect((await post(store, request(project, document, newHead, nextKey))).status).toBe(201)
    const [next] = await kei.listWorkflows({ workflowIDs: [child(document, nextKey)], loadInput: true })
    expect((next?.input?.[0] as KeiConvertInput)).toMatchObject({ model: 'second-ocr', layout_model: 'second-layout' })
  })

  it('one request key joins its running attempt and replays its revision after publication and history deletion', async () => {
    const { owner, store, project, document, head } = await fixture()
    await chooseIngestionModels(owner, { ocr: 'admitted-ocr' })
    await standIn.policy({ convert: 'hold' })
    const key = randomUUID()
    const req = () => request(project, document, head, key)
    const first = post(store, req())
    await until(async () => expect(await standIn.held()).toHaveLength(1))
    await chooseIngestionModels(owner, { ocr: 'changed-ocr' })
    const second = post(store, req())
    const [held] = await standIn.held()
    expect(held!.request).toMatchObject({ model: 'admitted-ocr' })
    await standIn.answer(held!.workflowId, { convert: 'auto' })
    const [one, two] = await Promise.all([first, second])
    expect(one.status).toBe(201)
    expect(two.status).toBe(201)
    const identity = await one.json()
    expect(await two.json()).toEqual(identity)
    const replay = await post(store, req())
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(identity)
    const revisions = await db.orm.public.SourceRepresentationRevision.where({ sourceDocumentId: document }).select('id').all()
    expect(revisions).toHaveLength(2)
    await DBOS.deleteWorkflows([workflow(document, key)])
    const afterHistory = await post(store, req())
    expect(afterHistory.status).toBe(200)
    expect(await afterHistory.json()).toEqual(identity)
    expect(await db.orm.public.SourceRepresentationRevision.where({ sourceDocumentId: document }).select('id').all()).toEqual(revisions)
    expect(await studioDbos().admission.listWorkflows({ workflowIDs: [workflow(document, key)] })).toHaveLength(0)
    expect(await kei.listWorkflows({ workflowIDs: [child(document, key)] })).toHaveLength(1)
  })

  it('rechecks the expected head under the document lock before publication', async () => {
    const { store, project, pdf, document, head } = await fixture()
    await standIn.policy({ convert: 'hold' })
    const key = randomUUID()
    const pending = post(store, request(project, document, head, key))
    await until(async () => expect(await standIn.held()).toHaveLength(1))
    const descriptor = await store.getSourceRepresentation(project, head)
    expect(descriptor).not.toBeNull()
    const current = await db.orm.public.SourceRepresentationRevision.select('preprocessId', 'parserName', 'parserVersion').first({ id: head })
    const advanced = await store.reprocessSourceDocument(project, document, {
      contentSha256: createHash('sha256').update(pdf).digest('hex'), mediaType: 'application/pdf', originalName: 'upload.pdf',
      ...descriptor!, contractVersion: 'parsed_document.v2', preprocessId: current!.preprocessId,
      parserName: current!.parserName, parserVersion: current!.parserVersion,
      requestKey: randomUUID(), requestFingerprint: randomUUID(), expectedRepresentationId: head,
      ensureRetained: async () => {},
    })
    expect(advanced?.revisionNumber).toBe(2)
    await standIn.answer((await standIn.held())[0]!.workflowId, { convert: 'auto' })
    const response = await pending
    expect(response.status, await response.clone().text()).toBe(409)
    const snapshot = await store.getDocumentReopenSnapshot(project, document)
    expect(snapshot?.sourceRepresentation.sourceRepresentationId).toBe(advanced?.sourceRepresentationId)
  })

  it('a reprocess published before a kill appends one revision after recovery', async () => {
    const { owner, store, project, document, head } = await fixture()
    const childSchema = testSchemas()
    dropped.push(childSchema.schema)
    const key = randomUUID()
    const env = {
      DATABASE_URL: url, KEI_EXP_URL: standIn.url, FREE_SOURCE_INBOX: inbox,
      FREE_TEST_DBOS_SCHEMA: childSchema.schema, FREE_TEST_KEI_SCHEMA: schemas.keiSchema,
      FREE_TEST_EXECUTOR: childSchema.executorId, FREE_TEST_PACKAGE_ROOT: join(scratch, 'packages'),
      FREE_TEST_ACCOUNT: owner, FREE_TEST_PROJECT: project, FREE_TEST_DOCUMENT: document,
      FREE_TEST_HEAD: head, FREE_TEST_REQUEST_KEY: key, FREE_CRASH_MARKER: join(scratch, `marker-${key}`),
    }
    const killed = await runWorkflowChild('reprocess-publish', env)
    expect(killed.signal, killed.output).toBe('SIGKILL')
    const before = await db.orm.public.SourceRepresentationRevision.where({ sourceDocumentId: document }).select('id').all()
    expect(before).toHaveLength(2)
    const recovered = await runWorkflowChild('reprocess-publish', env)
    expect(recovered.code, recovered.output).toBe(0)
    const after = await db.orm.public.SourceRepresentationRevision.where({ sourceDocumentId: document }).select('id').all()
    expect(after).toEqual(before)
    expect((await post(store, request(project, document, head, key))).status).toBe(200)
  })
})
