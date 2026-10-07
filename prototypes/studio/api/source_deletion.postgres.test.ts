import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { db, pool } from 'db'
import { createKeiHandoff, KEI_APPLICATION } from 'extraction/kei-handoff'
import { spawnKeiStandIn, type KeiStandInProcess } from 'extraction/kei-stand-in-client'
import { createCanonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import { launchStudioDbos, shutdownStudioDbos, studioDbos } from '../server/dbos.js'
import { publishFixtureParse, removeOwner, seedOwner } from '../test/support/ingestion.js'
import { blankPdf } from '../test/support/pdf.js'
import { disposableDatabaseUrl, dropSchemas, testSchemas } from '../test/support/postgres.js'
import { createProjectContextWrites } from './project_contexts.js'
import { createSourceDocumentDeletion } from './source_documents.js'

const url = disposableDatabaseUrl()
const scratch = mkdtempSync(join(tmpdir(), 'free-source-deletion-'))
const packages = createCanonicalPackageStore(join(scratch, 'packages'))
mkdirSync(join(scratch, 'inbox'))
const schemas = testSchemas()
const owners: string[] = []
const held = new Map<string, () => void>()
let standIn: KeiStandInProcess
let kei: DBOSClient

afterEach(async () => {
  for (const release of held.values()) release()
  held.clear()
  await standIn.policy({ convert: 'auto' })
  for (const work of await standIn.held()) await standIn.answer(work.workflowId, { convert: 'auto' })
})

beforeAll(async () => {
  standIn = await spawnKeiStandIn({ databaseUrl: url, schema: schemas.keiSchema })
  kei = await DBOSClient.create({ systemDatabaseUrl: url, systemDatabaseSchemaName: schemas.keiSchema, applicationName: KEI_APPLICATION })
  await launchStudioDbos({ databaseUrl: url, ...schemas, register: () => {
    DBOS.registerWorkflow(async () => new Promise<void>((resolve) => { held.set(DBOS.workflowID!, resolve) }), { name: 'scopeHeld' })
  } })
})

afterAll(async () => {
  try {
    for (const release of held.values()) release()
    for (const work of await standIn?.held() ?? []) await standIn.answer(work.workflowId, { convert: 'auto' })
    await shutdownStudioDbos()
    await standIn?.stop()
    await kei?.destroy()
    for (const owner of owners) await removeOwner(owner)
  } finally {
    try { await dropSchemas(url, schemas.schema, schemas.keiSchema) }
    finally { await db.close(); await pool.end(); rmSync(scratch, { recursive: true, force: true }) }
  }
})

const until = (check: () => Promise<void>) => vi.waitFor(check, { timeout: 30_000, interval: 50 })
async function fixture() {
  const { owner, store } = await seedOwner()
  owners.push(owner)
  const project = (await store.createProjectContext(`Deletion ${randomUUID()}`)).projectContextId
  const pdf = blankPdf(1, randomUUID())
  const document = (await publishFixtureParse(packages, store, project, pdf)).sourceDocumentId
  return { owner, store, project, document, pdf }
}
async function enqueue(id: string, owner: string, attributes: Record<string, string>) {
  await studioDbos().admission.enqueue({ workflowName: 'scopeHeld', queueName: 'studio', workflowID: id,
    authenticatedUser: owner, attributes }, null)
  await until(async () => expect(held.has(id)).toBe(true))
}
async function status(client: DBOSClient, id: string) {
  const [row] = await client.listWorkflows({ workflowIDs: [id], loadInput: false, loadOutput: false })
  return row?.status
}
async function child(owner: string, project: string, document: string, pdf: Uint8Array, parent: string) {
  const handoff = createKeiHandoff(studioDbos().kei, { pollIntervalMs: 50 })
  await standIn.policy({ convert: 'hold' })
  await handoff.submit({ workflow: 'convert', workflowId: `kei-convert:${parent}`, queueName: 'kei-convert-small',
    priority: 1, timeoutMs: 600_000, authenticatedUser: owner,
    attributes: { projectContextId: project, sourceDocumentId: document },
    request: { source: `${project}/${randomUUID()}.pdf`, source_sha256: createHash('sha256').update(pdf).digest('hex'),
      source_name: 'source.pdf', page_source: 'pdf', ingest: null, model: null, layout_model: null, cut: 'auto', debug: false },
  })
  await until(async () => expect((await standIn.held()).map((work) => work.workflowId)).toContain(`kei-convert:${parent}`))
}

describe('deletion cancels its live DBOS scope', () => {
  it('source deletion interrupts its suggestion and cancels Studio and kei children after the commit', async () => {
    const { owner, store, project, document, pdf } = await fixture()
    const suggestion = await db.orm.public.BatchSchemaSuggestion.create({ projectContextId: project,
      selectionKey: randomUUID(), attempt: 2, outcome: null, phase: 'READY',
      draft: { recordDescription: 'Retained.', schemaNodes: [{ id: 'place', name: 'Place', type: 'string' }] }, draftVersion: 1 })
    const snapshot = await store.getDocumentReopenSnapshot(project, document)
    await db.orm.public.BatchSchemaSuggestionSource.create({ batchSchemaSuggestionId: suggestion.id,
      sourceDocumentId: document, sourceRepresentationRevisionId: snapshot!.sourceRepresentation.sourceRepresentationId })
    const key = randomUUID()
    const ids = [`reprocess:${document}:${key}`, `suggest:${suggestion.id}:2`]
    for (const id of ids) await enqueue(id, owner, id.startsWith('suggest:')
      ? { projectContextId: project, batchSchemaSuggestionId: suggestion.id }
      : { projectContextId: project, sourceDocumentId: document })
    await child(owner, project, document, pdf, ids[0]!)

    const response = await createSourceDocumentDeletion(store)(new Request(
      `http://test/api/project-contexts/${project}/source-documents/${document}`, { method: 'DELETE' }))
    expect(response.status, await response.clone().text()).toBe(204)
    for (const id of ids) expect(await status(studioDbos().admission, id)).toBe('CANCELLED')
    expect(await status(kei, `kei-convert:${ids[0]}`)).toBe('CANCELLED')
    const interrupted = await db.orm.public.BatchSchemaSuggestion.select('outcome', 'failure', 'draft', 'draftVersion').first({ id: suggestion.id })
    expect(interrupted).toMatchObject({ outcome: 'FAILED', failure: { code: 'interrupted' }, draftVersion: 1 })
    expect(interrupted?.draft).toEqual({ recordDescription: 'Retained.', schemaNodes: [{ id: 'place', name: 'Place', type: 'string' }] })
    expect(await store.getDocumentReopenSnapshot(project, document)).toBeNull()
  })

  it('project deletion cancels its live Studio work and kei child', async () => {
    const { owner, store, project, document, pdf } = await fixture()
    const reprocess = `reprocess:${document}:${randomUUID()}`
    await enqueue(reprocess, owner, { projectContextId: project, sourceDocumentId: document })
    await child(owner, project, document, pdf, reprocess)
    const { DELETE } = createProjectContextWrites(store)
    const response = await DELETE(new Request(`http://test/api/project-contexts/${project}`, { method: 'DELETE' }))
    expect(response.status, await response.clone().text()).toBe(204)
    expect(await status(studioDbos().admission, reprocess)).toBe('CANCELLED')
    expect(await status(kei, `kei-convert:${reprocess}`)).toBe('CANCELLED')
  })

  it('source deletion cancels an orphaned live kei child of a terminal Studio parent', async () => {
    const { owner, store, project, document, pdf } = await fixture()
    const parent = `reprocess:${document}:${randomUUID()}`
    await enqueue(parent, owner, { projectContextId: project, sourceDocumentId: document })
    await studioDbos().admission.cancelWorkflow(parent)
    expect(await status(studioDbos().admission, parent)).toBe('CANCELLED')
    await child(owner, project, document, pdf, parent)
    const response = await createSourceDocumentDeletion(store)(new Request(
      `http://test/api/project-contexts/${project}/source-documents/${document}`, { method: 'DELETE' }))
    expect(response.status).toBe(204)
    expect(await status(kei, `kei-convert:${parent}`)).toBe('CANCELLED')
  })
})
