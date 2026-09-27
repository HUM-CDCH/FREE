import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DBOSClient } from '@dbos-inc/dbos-sdk'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { db, pool, type ResearcherProjectStore } from 'db'
import { dbosSteps } from 'extraction'
import { createKeiHandoff, KEI_APPLICATION, keiConvertWorkflowId, type KeiConvertInput } from 'extraction/kei-handoff'
import { spawnKeiStandIn, type KeiStandInProcess } from 'extraction/kei-stand-in-client'
import { createCanonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import { awaitWorkflowOutcome, launchStudioDbos, shutdownStudioDbos, studioDbos } from '../server/dbos.js'
import { runWorkflowChild } from '../test/support/crash.js'
import {
  chooseIngestionModels, ingestionStoreFor, publishFixtureParse, removeOwner, seedOwner, uploadRequest,
  type IngestionOwner,
} from '../test/support/ingestion.js'
import { blankPdf } from '../test/support/pdf.js'
import { disposableDatabaseUrl, dropSchemas, testSchemas } from '../test/support/postgres.js'
import { registerIngestionWorkflow, type IngestionOutcome } from './_ingestion_workflow.js'
import { countPdfPages } from './_pdf_pages.js'
import { createSourceDocumentIngestion, type Dependencies } from './source_documents.js'
import { createSourceIngestionDismissal, createSourceIngestionListing } from './source_ingestions.js'
import { sourceIngestionAdmittedSchema, sourceIngestionListingSchema } from '../shared/sourceDocumentIngestion.contract'

const url = disposableDatabaseUrl()
const scratch = mkdtempSync(join(tmpdir(), 'free-source-ingestion-'))
const packageRoot = join(scratch, 'packages')
const inbox = join(scratch, 'source-inbox')
mkdirSync(inbox)
const packages = createCanonicalPackageStore(packageRoot)
// This process runs ingestSource on `schemas`; a crash child gets a Studio schema of its own and shares kei's.
const schemas = testSchemas()
const dropped: string[] = [schemas.schema, schemas.keiSchema]
const owners: string[] = []
let standIn: KeiStandInProcess
let kei: DBOSClient
/** While set, kei's read API reports every run's result as only partially parsed. */
let partialResults = false
/** kei's read API as the workflow reads it: the stand-in's, with its result manifests marked partial on demand. */
const keiReads: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  if (!partialResults || !new URL(String(input)).pathname.endsWith('/result') || !response.ok) return response
  const manifest = (await response.json()) as Record<string, unknown>
  return Response.json({ ...manifest, status: 'incomplete', incomplete: 'page 1 stopped at its token cap' })
}

beforeAll(async () => {
  // kei first: its DBOS migrates the kei schema Studio's kei client enqueues into.
  standIn = await spawnKeiStandIn({ databaseUrl: url, schema: schemas.keiSchema })
  kei = await DBOSClient.create({ systemDatabaseUrl: url, systemDatabaseSchemaName: schemas.keiSchema, applicationName: KEI_APPLICATION })
  await launchStudioDbos({
    databaseUrl: url,
    ...schemas,
    register: () =>
      registerIngestionWorkflow(() => ({
        steps: dbosSteps,
        kei: createKeiHandoff(studioDbos().kei, { pollIntervalMs: 100 }),
        readBase: standIn.url,
        inboxRoot: inbox,
        packageStore: packages,
        storeFor: ingestionStoreFor(packages),
        fetcher: keiReads,
      })),
  })
})

afterEach(async () => {
  partialResults = false
  // A conversion a failed test left held would occupy its kei lane for every later test.
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
    try {
      await dropSchemas(url, ...dropped)
    } finally {
      await db.close()
      await pool.end()
      rmSync(scratch, { recursive: true, force: true })
    }
  }
})

async function owned(): Promise<IngestionOwner> {
  const seeded = await seedOwner()
  owners.push(seeded.owner)
  return seeded
}

async function project(store: ResearcherProjectStore) {
  return (await store.createProjectContext(`Ingestion ${randomUUID()}`)).projectContextId
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
/** A PDF no other test uploads. */
const uniquePdf = (pages = 3) => blankPdf(pages, randomUUID())

/** The Studio admission client, recording the workflow each enqueue answered with (ours, or the one it joined). */
function recordingAdmission() {
  const answered: string[] = []
  const admission: NonNullable<Dependencies['admission']> = {
    enqueue: (async (...args: Parameters<DBOSClient['enqueue']>) => {
      const handle = await studioDbos().admission.enqueue(...args)
      answered.push(handle.workflowID)
      return handle
    }) as DBOSClient['enqueue'],
  }
  return { answered, admission }
}

function ingest(store: ResearcherProjectStore, projectContextId: string, pdf: Uint8Array, dependencies: Dependencies = {}) {
  return createSourceDocumentIngestion(store, { inboxRoot: inbox, packageStore: packages, ...dependencies })(
    uploadRequest(projectContextId, pdf),
  )
}

/** The admitted workflow's ID: Studio answers 202 once ingestSource is enqueued (or joined). */
async function admitted(response: Response): Promise<string> {
  expect(response.status, await response.clone().text()).toBe(202)
  return sourceIngestionAdmittedSchema.parse(await response.json()).workflowId
}

/** Waits for an admitted attempt's outcome. Tests wait; the upload request never does. */
async function settled(workflowId: string): Promise<IngestionOutcome> {
  const outcome = await awaitWorkflowOutcome<IngestionOutcome>(studioDbos().admission, workflowId, { timeoutMs: 60_000, intervalMs: 50 })
  expect(outcome.state, JSON.stringify(outcome)).toBe('finished')
  return (outcome as { output: IngestionOutcome }).output
}

/** The Source Document an upload became: a 201 replay at once, or a 202 attempt once it published. */
async function created(response: Response) {
  if (response.status === 201)
    return (await response.json()) as { sourceDocumentId: string; sourceRepresentationId: string; pageCount: number }
  const outcome = await settled(await admitted(response))
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
  const { sourceDocument, pageCount } = outcome as Extract<IngestionOutcome, { ok: true }>
  return { ...sourceDocument, pageCount }
}

const ingestWorkflows = (projectContextId: string) =>
  studioDbos().admission.listWorkflows({ workflow_id_prefix: `ingest:${projectContextId}:`, loadInput: true, loadOutput: true })
const convertWorkflows = (projectContextId: string) =>
  kei.listWorkflows({ workflow_id_prefix: keiConvertWorkflowId(`ingest:${projectContextId}:`), loadInput: true })
const convertInput = (row: { input?: unknown[] }) => row.input?.[0] as KeiConvertInput
const staged = (projectContextId: string) => readdir(join(inbox, projectContextId)).catch(() => [] as string[])
const held = () => standIn.held()
const until = (assertion: () => Promise<void>) => vi.waitFor(assertion, { timeout: 60_000, interval: 50 })

async function sourceDocuments(projectContextId: string) {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const { rows } = await client.query<{ id: string; revisions: number; xmin: string }>(
      `SELECT d.id, count(r.id)::int AS revisions, d.xmin::text AS xmin FROM "sourceDocument" d
         LEFT JOIN "sourceRepresentationRevision" r ON r."sourceDocumentId" = d.id
        WHERE d."projectContextId" = $1 GROUP BY d.id`,
      [projectContextId],
    )
    return rows
  } finally {
    await client.end()
  }
}

describe('ingestSource on PostgreSQL', () => {
  it('completed content replays before parsing: no staged file and no workflow', async () => {
    const { store } = await owned()
    const projectContextId = await project(store)
    const pdf = uniquePdf()
    const first = await created(await ingest(store, projectContextId, pdf))
    expect(await ingestWorkflows(projectContextId)).toHaveLength(1)

    const countPages = vi.fn(countPdfPages)
    const replayed = await created(await ingest(store, projectContextId, pdf, { countPages }))

    expect(replayed).toEqual(first)
    expect(countPages).not.toHaveBeenCalled()
    expect(await ingestWorkflows(projectContextId)).toHaveLength(1)
    expect(await convertWorkflows(projectContextId)).toHaveLength(1)
    expect(await staged(projectContextId)).toEqual([])
  })

  it('a re-upload while the attempt is live answers the same workflow ID and publishes once', async () => {
    const { store } = await owned()
    const projectContextId = await project(store)
    const pdf = uniquePdf()
    await standIn.policy({ convert: 'hold' })

    const first = await admitted(await ingest(store, projectContextId, pdf))
    await until(async () => expect(await held()).toHaveLength(1))
    const [attempt] = await ingestWorkflows(projectContextId)
    expect(attempt?.status).toBe('PENDING')
    expect(attempt?.workflowID).toBe(first)

    const { answered, admission } = recordingAdmission()
    const reupload = await ingest(store, projectContextId, pdf, { admission })
    expect(answered).toEqual([attempt!.workflowID])
    expect(await admitted(reupload.clone())).toBe(first)
    const [child] = await held()
    await standIn.answer(child!.workflowId, { convert: 'auto' })
    const document = await created(reupload)

    const [finished] = await ingestWorkflows(projectContextId)
    expect(finished?.output).toMatchObject({ ok: true, sourceDocument: { sourceDocumentId: document.sourceDocumentId } })
    expect(await ingestWorkflows(projectContextId)).toHaveLength(1)
    expect((await convertWorkflows(projectContextId)).map((row) => row.workflowID)).toEqual([keiConvertWorkflowId(attempt!.workflowID)])
    expect(await staged(projectContextId)).toEqual([])
    expect(await sourceDocuments(projectContextId)).toHaveLength(1)
  })

  it("simultaneous same-content uploads in one project run one workflow, and the loser's staged file is removed", async () => {
    const { store } = await owned()
    const projectContextId = await project(store)
    const pdf = uniquePdf()
    await standIn.policy({ convert: 'hold' })
    const { answered, admission } = recordingAdmission()

    const uploads = [ingest(store, projectContextId, pdf, { admission }), ingest(store, projectContextId, pdf, { admission })]
    await until(async () => {
      expect(answered).toHaveLength(2)
      expect(await held()).toHaveLength(1)
    })
    expect(answered[0]).toBe(answered[1])
    // Only the running attempt's file is left while kei holds it.
    expect(await staged(projectContextId)).toEqual([`${answered[0]!.split(':')[2]}.pdf`])
    await standIn.answer((await held())[0]!.workflowId, { convert: 'auto' })
    const [first, second] = await Promise.all(uploads.map(async (upload) => created(await upload)))

    expect(second).toEqual(first)
    expect(await ingestWorkflows(projectContextId)).toHaveLength(1)
    expect(await convertWorkflows(projectContextId)).toHaveLength(1)
    expect(await staged(projectContextId)).toEqual([])
  })

  it('identical PDFs in two projects stage independent files and run independently', async () => {
    const { store } = await owned()
    const projects = [await project(store), await project(store)]
    const pdf = uniquePdf()
    await standIn.policy({ convert: 'hold' })

    const uploads = projects.map((projectContextId) => ingest(store, projectContextId, pdf))
    // Each project has its own attempt and kei child; kei's small lane holds one and queues the other.
    await until(async () => {
      for (const projectContextId of projects) expect(await convertWorkflows(projectContextId)).toHaveLength(1)
    })
    for (const projectContextId of projects) {
      expect(await staged(projectContextId)).toHaveLength(1)
      expect(await ingestWorkflows(projectContextId)).toHaveLength(1)
    }
    const documents = Promise.all(uploads.map(async (upload) => created(await upload)))
    for (let released = 0; released < projects.length; released += 1) {
      await until(async () => expect(await held()).toHaveLength(1))
      await standIn.answer((await held())[0]!.workflowId, { convert: 'auto' })
    }
    const [first, second] = await documents

    expect(second.sourceDocumentId).not.toBe(first.sourceDocumentId)
    for (const projectContextId of projects) {
      expect(await convertWorkflows(projectContextId)).toHaveLength(1)
      expect(await staged(projectContextId)).toEqual([])
      expect(await sourceDocuments(projectContextId)).toHaveLength(1)
    }
  })

  it("content completed after the precheck is replayed by the workflow's first step", async () => {
    const { store } = await owned()
    const projectContextId = await project(store)
    const pdf = uniquePdf()
    let completedElsewhere: string | undefined

    const response = await ingest(store, projectContextId, pdf, {
      // Another attempt publishes these bytes between this request's precheck and its enqueue.
      beforeEnqueue: async () => {
        completedElsewhere = (await publishFixtureParse(packages, store, projectContextId, pdf)).sourceDocumentId
      },
    })

    expect((await created(response)).sourceDocumentId).toBe(completedElsewhere)
    const [attempt] = await ingestWorkflows(projectContextId)
    expect(attempt?.output).toMatchObject({ ok: true, sourceDocument: { sourceDocumentId: completedElsewhere } })
    expect(await convertWorkflows(projectContextId)).toEqual([])
    expect(await staged(projectContextId)).toEqual([])
    expect(await sourceDocuments(projectContextId)).toHaveLength(1)
  })

  it('a failed attempt releases deduplication and a re-upload starts a new attempt without any client key', async () => {
    const { store } = await owned()
    const projectContextId = await project(store)
    const pdf = uniquePdf()
    await standIn.policy({ convert: { failure: { code: 'source_unreadable', reason: 'PDFium could not open it', retryable: false } } })

    const failed = await settled(await admitted(await ingest(store, projectContextId, pdf)))
    expect(failed).toEqual({
      ok: false, status: 422, code: 'source_ingestion_failed', message: 'The Source Document could not be parsed: PDFium could not open it',
    })
    expect(await staged(projectContextId)).toEqual([])

    await standIn.policy({ convert: 'auto' })
    await created(await ingest(store, projectContextId, pdf))
    const attempts = await ingestWorkflows(projectContextId)
    expect(attempts).toHaveLength(2)
    expect(new Set(attempts.map((row) => row.workflowID)).size).toBe(2)
    expect(await convertWorkflows(projectContextId)).toHaveLength(2)
    expect(await sourceDocuments(projectContextId)).toHaveLength(1)
  })

  it("Studio's refusal of kei's result is a typed outcome, ends the workflow in SUCCESS and releases deduplication", async () => {
    const { store } = await owned()
    const projectContextId = await project(store)
    const pdf = uniquePdf()
    partialResults = true

    const refused = await settled(await admitted(await ingest(store, projectContextId, pdf)))
    expect(refused).toEqual({ ok: false, status: 422, code: 'source_ingestion_failed', message: 'The Source Document was only partially parsed.' })
    const [attempt] = await ingestWorkflows(projectContextId)
    expect(attempt).toMatchObject({
      status: 'SUCCESS',
      output: { ok: false, status: 422, code: 'source_ingestion_failed', message: 'The Source Document was only partially parsed.' },
    })
    expect(await staged(projectContextId)).toEqual([])
    expect(await sourceDocuments(projectContextId)).toEqual([])

    partialResults = false
    await created(await ingest(store, projectContextId, pdf))
    expect(await ingestWorkflows(projectContextId)).toHaveLength(2)
    expect(await sourceDocuments(projectContextId)).toHaveLength(1)
  })

  it('two same-content uploads under different choices join one attempt with the first admitted models', async () => {
    const { owner, store } = await owned()
    const projectContextId = await project(store)
    const pdf = uniquePdf()
    await chooseIngestionModels(owner, { ocr: 'first-ocr', layout: 'first-layout' })
    await standIn.policy({ convert: 'hold' })
    const { answered, admission } = recordingAdmission()

    const first = ingest(store, projectContextId, pdf, { admission })
    await until(async () => expect(await held()).toHaveLength(1))
    await chooseIngestionModels(owner, { ocr: 'second-ocr', layout: 'second-layout' })
    const second = ingest(store, projectContextId, pdf, { admission })
    await until(async () => expect(answered).toHaveLength(2))
    expect(answered[1]).toBe(answered[0])
    const [child] = await held()
    expect(child!.request).toMatchObject({ model: 'first-ocr', layout_model: 'first-layout' })
    await standIn.answer(child!.workflowId, { convert: 'auto' })
    const [one, other] = await Promise.all([first, second].map(async (upload) => created(await upload)))

    expect(other).toEqual(one)
    const children = await convertWorkflows(projectContextId)
    expect(children).toHaveLength(1)
    expect(convertInput(children[0]!)).toMatchObject({ model: 'first-ocr', layout_model: 'first-layout' })
  })

  it('a small PDF converts on kei-convert-small; a large or uncounted one on kei-convert-large', async () => {
    const { store } = await owned()
    const projectContextId = await project(store)
    const small = uniquePdf(3)
    const large = uniquePdf(31)
    const uncounted = new Uint8Array([...new TextEncoder().encode('%PDF-1.7\n'), ...randomBytes(256)])
    for (const pdf of [small, large, uncounted]) await created(await ingest(store, projectContextId, pdf))

    const lanes = Object.fromEntries((await convertWorkflows(projectContextId)).map((row) => [convertInput(row).source_sha256, row.queueName]))
    expect(lanes).toEqual({
      [sha256(small)]: 'kei-convert-small',
      [sha256(large)]: 'kei-convert-large',
      [sha256(uncounted)]: 'kei-convert-large',
    })
    const admitted = Object.fromEntries((await ingestWorkflows(projectContextId)).map((row) => {
      const input = row.input?.[0] as { sourceSha256: string; pageCount: number | null }
      return [input.sourceSha256, input.pageCount]
    }))
    expect(admitted).toEqual({ [sha256(small)]: 3, [sha256(large)]: 31, [sha256(uncounted)]: null })
  })
})

describe('Source Ingestions on PostgreSQL', () => {
  const list = async (store: ResearcherProjectStore, projectContextId: string, named: string[] = []) => {
    const query = named.map((id) => `workflowId=${encodeURIComponent(id)}`).join('&')
    const response = await createSourceIngestionListing(store)(
      new Request(`http://studio.test/api/project-contexts/${projectContextId}/source-ingestions${query ? `?${query}` : ''}`),
    )
    return { status: response.status, body: response.status === 200 ? sourceIngestionListingSchema.parse(await response.json()) : null }
  }
  const dismiss = (store: ResearcherProjectStore, projectContextId: string, workflowId: string) =>
    createSourceIngestionDismissal(store)(new Request(
      `http://studio.test/api/project-contexts/${projectContextId}/source-ingestions/${encodeURIComponent(workflowId)}`,
      { method: 'DELETE' },
    ))
  const unreadable = { convert: { failure: { code: 'source_unreadable', reason: 'PDFium could not open it', retryable: false } } } as const

  it('small and large uploads both answer 202 before either conversion is released, and list as live', async () => {
    const { store } = await owned()
    const projectContextId = await project(store)
    await standIn.policy({ convert: 'hold' })

    const small = await admitted(await ingest(store, projectContextId, uniquePdf(3)))
    const large = await admitted(await ingest(store, projectContextId, uniquePdf(31)))

    const { body } = await list(store, projectContextId)
    expect(body!.ingestions.map((row) => row.workflowId).sort()).toEqual([small, large].sort())
    expect(body!.ingestions.every((row) => row.status === 'queued' || row.status === 'parsing')).toBe(true)
    await until(async () => expect(await held()).toHaveLength(2))
    for (const work of await held()) await standIn.answer(work.workflowId, { convert: 'auto' })
    for (const workflowId of [small, large]) expect((await settled(workflowId)).ok).toBe(true)
    const after = await list(store, projectContextId)
    expect(after.body!.ingestions.map((row) => row.status)).toEqual(['succeeded', 'succeeded'])
  })

  it('a typed parse failure is listed with its reason, and a re-upload that succeeds supersedes it', async () => {
    const { store } = await owned()
    const projectContextId = await project(store)
    const pdf = uniquePdf()
    await standIn.policy(unreadable)
    const failed = await admitted(await ingest(store, projectContextId, pdf))
    await settled(failed)

    const { body } = await list(store, projectContextId)
    expect(body!.ingestions).toEqual([expect.objectContaining({
      workflowId: failed, status: 'failed',
      failure: { code: 'source_ingestion_failed', message: 'The Source Document could not be parsed: PDFium could not open it' },
    })])

    await standIn.policy({ convert: 'auto' })
    const retried = await admitted(await ingest(store, projectContextId, pdf))
    await settled(retried)
    const after = await list(store, projectContextId)
    expect(after.body!.ingestions.map((row) => [row.workflowId, row.status])).toEqual([[retried, 'succeeded']])
  })

  it('a failed attempt whose content was published since is listed as that Source Document', async () => {
    const { store } = await owned()
    const projectContextId = await project(store)
    const pdf = uniquePdf()
    await standIn.policy(unreadable)
    const failed = await admitted(await ingest(store, projectContextId, pdf))
    await settled(failed)
    const published = await publishFixtureParse(packages, store, projectContextId, pdf)

    const { body } = await list(store, projectContextId)
    expect(body!.ingestions).toEqual([expect.objectContaining({ workflowId: failed, status: 'succeeded', sourceDocumentId: published.sourceDocumentId })])
  })

  it('Dismiss deletes the failed chain of that content, and it stays gone for another request', async () => {
    const { store } = await owned()
    const projectContextId = await project(store)
    const pdf = uniquePdf()
    await standIn.policy(unreadable)
    const older = await admitted(await ingest(store, projectContextId, pdf))
    await settled(older)
    const newest = await admitted(await ingest(store, projectContextId, pdf))
    await settled(newest)
    expect((await list(store, projectContextId)).body!.ingestions.map((row) => row.workflowId)).toEqual([newest])

    expect((await dismiss(store, projectContextId, newest)).status).toBe(204)

    const after = await list(store, projectContextId, [older, newest])
    expect(after.body).toEqual({ ingestions: [], absent: [older, newest] })
    expect(await studioDbos().admission.listWorkflows({ workflowIDs: [older, newest] })).toEqual([])
    expect((await dismiss(store, projectContextId, newest)).status).toBe(204)
  })

  it('an attempt cancelled in this process is refused with 409 ingestion_stopping, and nothing of its chain is deleted', async () => {
    const { store } = await owned()
    const projectContextId = await project(store)
    await standIn.policy({ convert: 'hold' })
    const workflowId = await admitted(await ingest(store, projectContextId, uniquePdf()))
    await until(async () => expect(await held()).toHaveLength(1))
    await studioDbos().admission.cancelWorkflow(workflowId)
    await until(async () => expect((await studioDbos().admission.getWorkflow(workflowId))?.status).toBe('CANCELLED'))

    const refused = await dismiss(store, projectContextId, workflowId)
    expect(refused.status).toBe(409)
    expect((await refused.json()).error.code).toBe('ingestion_stopping')
    expect(await studioDbos().admission.getWorkflow(workflowId)).toBeDefined()
  })

  it("another account's request reads nothing, and a deleted project answers 404 before any history is collected", async () => {
    const { store } = await owned()
    const other = await owned()
    const projectContextId = await project(store)
    const workflowId = await admitted(await ingest(store, projectContextId, uniquePdf()))
    await settled(workflowId)

    expect((await list(other.store, projectContextId, [workflowId])).status).toBe(404)
    expect((await dismiss(other.store, projectContextId, workflowId)).status).toBe(404)
    await store.deleteProjectContext(projectContextId)
    expect((await list(store, projectContextId, [workflowId])).status).toBe(404)
    expect(await studioDbos().admission.getWorkflow(workflowId)).toBeDefined()
  })
})

describe('ingestSource across Studio restarts', () => {
  /** A crash child's environment: its own Studio schema and executor, this file's kei stand-in, inbox and packages. */
  function childEnv(owner: string, projectContextId: string, pdf: Uint8Array, mode: 'kill-after-publish' | 'kill-before-submit') {
    const child = testSchemas()
    dropped.push(child.schema)
    const pdfPath = join(scratch, `${projectContextId}.pdf`)
    writeFileSync(pdfPath, pdf)
    return {
      schema: child.schema,
      env: {
        DATABASE_URL: url,
        KEI_EXP_URL: standIn.url,
        FREE_SOURCE_INBOX: inbox,
        FREE_TEST_DBOS_SCHEMA: child.schema,
        FREE_TEST_KEI_SCHEMA: schemas.keiSchema,
        FREE_TEST_EXECUTOR: child.executorId,
        FREE_TEST_PACKAGE_ROOT: packageRoot,
        FREE_TEST_INGESTION_MODE: mode,
        FREE_TEST_ACCOUNT: owner,
        FREE_TEST_PROJECT: projectContextId,
        FREE_TEST_PDF: pdfPath,
        FREE_CRASH_MARKER: join(scratch, `marker-${projectContextId}`),
      },
    }
  }

  async function childOutcome(schema: string, projectContextId: string) {
    const studio = await DBOSClient.create({ systemDatabaseUrl: url, systemDatabaseSchemaName: schema, applicationName: 'studio' })
    try {
      const attempts = await studio.listWorkflows({ workflow_id_prefix: `ingest:${projectContextId}:`, loadInput: false })
      expect(attempts).toHaveLength(1)
      const outcome = await awaitWorkflowOutcome<IngestionOutcome>(studio, attempts[0]!.workflowID, { timeoutMs: 1_000 })
      return { workflowId: attempts[0]!.workflowID, outcome }
    } finally {
      await studio.destroy()
    }
  }

  it('an ingestion published before a kill is published once', async () => {
    const { owner, store } = await owned()
    const projectContextId = await project(store)
    const { schema, env } = childEnv(owner, projectContextId, uniquePdf(), 'kill-after-publish')

    const killed = await runWorkflowChild('ingestion-publish', env)
    expect(killed.signal, killed.output).toBe('SIGKILL')
    const [published] = await sourceDocuments(projectContextId)
    expect(published).toMatchObject({ revisions: 1 })

    const recovered = await runWorkflowChild('ingestion-publish', env)
    expect(recovered.code, recovered.output).toBe(0)

    // The replayed publication found the document it had committed and wrote nothing.
    expect(await sourceDocuments(projectContextId)).toEqual([published])
    const { workflowId, outcome } = await childOutcome(schema, projectContextId)
    expect(outcome).toMatchObject({ state: 'finished', output: { ok: true, sourceDocument: { sourceDocumentId: published!.id } } })
    expect((await convertWorkflows(projectContextId)).map((row) => row.workflowID)).toEqual([keiConvertWorkflowId(workflowId)])
    expect(await staged(projectContextId)).toEqual([])
  })

  it('an ingestion recovered after its owner changed the Ingestion Model Choice converts with the models it was admitted with', async () => {
    const { owner, store } = await owned()
    const projectContextId = await project(store)
    await chooseIngestionModels(owner, { ocr: 'admitted-ocr', layout: 'admitted-layout' })
    const { schema, env } = childEnv(owner, projectContextId, uniquePdf(), 'kill-before-submit')

    // The first run is admitted with the owner's choice, then dies before its workflow reaches kei.
    const killed = await runWorkflowChild('ingestion-publish', env)
    expect(killed.signal, killed.output).toBe('SIGKILL')
    expect(await convertWorkflows(projectContextId)).toEqual([])
    await chooseIngestionModels(owner, { ocr: 'changed-ocr', layout: 'changed-layout' })

    const recovered = await runWorkflowChild('ingestion-publish', env)
    expect(recovered.code, recovered.output).toBe(0)

    const children = await convertWorkflows(projectContextId)
    expect(children).toHaveLength(1)
    expect(convertInput(children[0]!)).toMatchObject({ model: 'admitted-ocr', layout_model: 'admitted-layout' })
    const { outcome } = await childOutcome(schema, projectContextId)
    expect(outcome).toMatchObject({ state: 'finished', output: { ok: true } })
    expect(await sourceDocuments(projectContextId)).toHaveLength(1)
  })
})
