import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createInternalProjectWorkerStore, db, INTERRUPTED_FAILURE, pool } from 'db'
import { dbosSteps } from 'extraction'
import { createCanonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import { launchStudioDbos, shutdownStudioDbos, studioDbos } from '../server/dbos.js'
import { modelOperationListingSchema, type ModelOperation } from '../shared/modelOperation.contract.js'
import {
  configureOwnerRoute,
  removeInteractiveScope,
  seedInteractiveScope,
  seedSchemaRevision,
  type InteractiveScope,
} from '../test/support/interactive.js'
import { disposableDatabaseUrl, dropSchemas, testSchemas } from '../test/support/postgres.js'
import { startScriptedModelServer, type ScriptedModelServer } from '../test/support/scriptedModelServer.js'
import { suggestionResearcherStore } from '../test/support/suggestionWorkflow.js'
import { deploymentModels } from './_deployment_models.js'
import { generateSchemaWithModel } from './_schema_suggestion.js'
import { createModelKeyCache } from './_model_keys.js'
import { generateSchemaEditJson, proposeSchemaEdit } from './_schema_edit.js'
import { registerSchemaEditWorkflow, type SchemaEditPorts } from './_schema_edit_workflow.js'
import { registerSchemaGenerationWorkflow, type SchemaGenerationPorts } from './_schema_generation_workflow.js'
import { createPostEditSchema } from './edit_schema.js'
import { createPostGenerateSchema } from './generate_schema.js'
import { createModelOperationHandlers } from './model_operations.js'

const url = disposableDatabaseUrl()
const scratch = mkdtempSync(join(tmpdir(), 'free-model-operations-'))
const packages = createCanonicalPackageStore(join(scratch, 'packages'))
const schemas = testSchemas()
const scopes: InteractiveScope[] = []
const TEMPLATE = '{"_description":"One catalogue entry.","title":"string"}'
const ENVELOPE = '{"fields":{},"additions":[]}'
const PROPOSED = { status: 'proposed', fields: {}, additions: [], issues: [] }

let server: ScriptedModelServer
const keys = createModelKeyCache()
const worker = createInternalProjectWorkerStore(db, { packages })
const generationPorts: SchemaGenerationPorts = {
  steps: dbosSteps,
  readSource: (id) => worker.readRevisionSchemaSource(id),
  generate: (caller, input) =>
    generateSchemaWithModel(caller, input, undefined, { keys, keyWaitMs: 400, deployment: deploymentModels({}) }),
}
const editPorts: SchemaEditPorts = {
  steps: dbosSteps,
  readSchemaTree: (schemaId, revisionId) => worker.readSchemaRevisionTree(schemaId, revisionId),
  readMarkdown: (id) => worker.readRevisionMarkdown(id),
  propose: proposeSchemaEdit,
  generateJson: (caller, prompt, temperature, signal, target) =>
    generateSchemaEditJson(caller, prompt, temperature, signal, target, { keys, keyWaitMs: 400, deployment: deploymentModels({}) }),
}

type Base = { extractionSchemaId: string; schemaRevisionId: string }

/** The handlers on the account's real store and this process's admission client, as server/app.ts wires them. */
function handlersFor(accountId: string) {
  return createModelOperationHandlers(suggestionResearcherStore(accountId), () => studioDbos().admission)
}

function listing(accountId: string, projectContextId: string, extractionSchemaId?: string) {
  const query = new URLSearchParams({ projectContextId, ...(extractionSchemaId ? { extractionSchemaId } : {}) })
  return handlersFor(accountId).GET(new Request(`http://local.test/api/model-operations?${query}`))
}

async function operations(accountId: string, projectContextId: string, extractionSchemaId?: string): Promise<ModelOperation[]> {
  const response = await listing(accountId, projectContextId, extractionSchemaId)
  expect(response.status).toBe(200)
  return modelOperationListingSchema.parse(await response.json()).operations
}

function remove(accountId: string, workflowId: string) {
  return handlersFor(accountId).DELETE(
    new Request(`http://local.test/api/model-operations/${encodeURIComponent(workflowId)}`, { method: 'DELETE' }),
  )
}

function generate(scope: InteractiveScope, operationId: string, instruction = 'Catalog entries') {
  const form = new FormData()
  form.append('project_context_id', scope.projectContextId)
  form.append('source_representation_revision_id', scope.sourceRepresentationRevisionId)
  form.append('operation_id', operationId)
  form.append('instruction', instruction)
  const handler = createPostGenerateSchema(suggestionResearcherStore(scope.accountId), () => studioDbos().admission)
  return handler(new Request('http://local.test/api/generate_schema', { method: 'POST', body: form }))
}

function propose(scope: InteractiveScope, base: Base, operationId: string) {
  const form = new FormData()
  form.append('project_context_id', scope.projectContextId)
  form.append('extraction_schema_id', base.extractionSchemaId)
  form.append('schema_revision_id', base.schemaRevisionId)
  form.append('operation_id', operationId)
  form.append('instruction', `Rename title to heading (${operationId})`)
  const handler = createPostEditSchema(suggestionResearcherStore(scope.accountId), () => studioDbos().admission)
  return handler(new Request('http://local.test/api/edit_schema', { method: 'POST', body: form }))
}

/** A researcher with one document and a keyless scripted route on both model routes. */
async function seed(): Promise<InteractiveScope> {
  const scope = await seedInteractiveScope(packages)
  scopes.push(scope)
  await configureOwnerRoute(scope.accountId, { provider: 'openai-compatible', baseUrl: server.baseUrl, modelId: 'scripted', hasKey: false }, keys)
  return scope
}

async function statusOf(workflowId: string) {
  return (await studioDbos().admission.getWorkflow(workflowId))?.status
}

async function until(predicate: () => Promise<boolean> | boolean, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** A generation whose scripted call is held: the operation is running until the call is released or cancelled. */
async function runningGeneration(scope: InteractiveScope) {
  const operationId = randomUUID()
  const callsBefore = server.calls().length
  server.reply({ text: TEMPLATE, hold: true })
  const response = generate(scope, operationId)
  await server.waitForCall(callsBefore + 1)
  return { workflowId: `suggestion:${operationId}`, response }
}

async function finishedGeneration(scope: InteractiveScope) {
  const operationId = randomUUID()
  server.reply({ text: TEMPLATE })
  expect((await generate(scope, operationId)).status).toBe(200)
  return `suggestion:${operationId}`
}

beforeAll(async () => {
  server = await startScriptedModelServer()
  await launchStudioDbos({
    databaseUrl: url,
    ...schemas,
    register: () => {
      registerSchemaGenerationWorkflow(() => generationPorts)
      registerSchemaEditWorkflow(() => editPorts)
    },
  })
})

afterEach(() => {
  server.release()
  keys.clear()
})

afterAll(async () => {
  try {
    await shutdownStudioDbos()
    for (const scope of scopes) await removeInteractiveScope(scope)
  } finally {
    try {
      await dropSchemas(url, schemas.schema, schemas.keiSchema)
    } finally {
      await server.close()
      await db.close()
      await pool.end()
      rmSync(scratch, { recursive: true, force: true })
    }
  }
})

describe('GET and DELETE /api/model-operations on PostgreSQL', () => {
  it('a first generation is listed under the project with no Extraction Schema, and not under a schema', async () => {
    const scope = await seed()
    const workflowId = await finishedGeneration(scope)
    const base = await seedSchemaRevision(scope)

    const listed = await operations(scope.accountId, scope.projectContextId)
    expect(listed).toEqual([{
      kind: 'generation', workflowId, operationId: workflowId.slice('suggestion:'.length), status: 'SUCCEEDED',
      instruction: 'Catalog entries', createdAt: expect.any(String), failure: null, baseSchemaRevisionId: null,
      template: { _description: 'One catalogue entry.', title: 'string' },
    }])
    expect(await operations(scope.accountId, scope.projectContextId, base.extractionSchemaId)).toEqual([])
  })

  it('a running operation is listed with its instruction, and DELETE cancels it', async () => {
    const scope = await seed()
    const { workflowId, response } = await runningGeneration(scope)

    const [running] = await operations(scope.accountId, scope.projectContextId)
    expect(running).toMatchObject({ kind: 'generation', workflowId, status: 'RUNNING', instruction: 'Catalog entries', failure: null, template: null })

    const cancelled = await remove(scope.accountId, workflowId)
    expect(cancelled.status).toBe(204)
    expect(cancelled.headers.get('cache-control')).toBe('no-store')
    await until(async () => (await statusOf(workflowId)) === 'CANCELLED', 5_000, 'the workflow to be cancelled')
    expect((await response).status).toBe(409)
    const [stopped] = await operations(scope.accountId, scope.projectContextId)
    expect(stopped).toMatchObject({ workflowId, status: 'FAILED', failure: { ...INTERRUPTED_FAILURE } })
  })

  it('Discard deletes that proposal and every older finished proposal on its base; a newer one from another tab survives', async () => {
    const scope = await seed()
    const base = await seedSchemaRevision(scope)
    const other: Base = { extractionSchemaId: base.extractionSchemaId, schemaRevisionId: randomUUID() }
    await db.orm.public.SchemaRevision.create({
      id: other.schemaRevisionId, extractionSchemaId: base.extractionSchemaId, revisionNumber: 2, origin: 'RESEARCHER_EDIT',
      schemaTree: { recordDescription: 'One catalogue entry.', schemaNodes: [] },
    })
    const ids: string[] = []
    for (const target of [base, base, base, other]) {
      const operationId = randomUUID()
      server.reply({ text: ENVELOPE })
      const response = await propose(scope, target, operationId)
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual(PROPOSED)
      ids.push(`edit:${operationId}`)
    }
    const [p1, p2, p3, q] = ids as [string, string, string, string]
    expect((await operations(scope.accountId, scope.projectContextId, base.extractionSchemaId)).map((operation) => operation.workflowId)).toEqual([q, p3, p2, p1])

    expect((await remove(scope.accountId, p2)).status).toBe(204)

    const surviving = await operations(scope.accountId, scope.projectContextId, base.extractionSchemaId)
    expect(surviving.map((operation) => operation.workflowId)).toEqual([q, p3])
    expect(surviving.map((operation) => operation.baseSchemaRevisionId)).toEqual([other.schemaRevisionId, base.schemaRevisionId])
    expect(await statusOf(p1)).toBeUndefined()
    expect(await statusOf(p2)).toBeUndefined()
    // A second Discard of a gone proposal is 404; discarding the newest deletes only it now.
    expect((await remove(scope.accountId, p2)).status).toBe(404)
    expect((await remove(scope.accountId, p3)).status).toBe(204)
    expect((await operations(scope.accountId, scope.projectContextId, base.extractionSchemaId)).map((operation) => operation.workflowId)).toEqual([q])
  })

  it('two proposals admitted in the same millisecond are discarded in the order the listing shows', async () => {
    const scope = await seed()
    const base = await seedSchemaRevision(scope)
    const ids: string[] = []
    for (let i = 0; i < 2; i += 1) {
      const operationId = randomUUID()
      server.reply({ text: ENVELOPE })
      expect((await propose(scope, base, operationId)).status).toBe(200)
      ids.push(`edit:${operationId}`)
    }
    // DBOS stamps created_at in milliseconds and orders by it alone: make the two share one stamp.
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    try {
      await client.query(
        `UPDATE "${schemas.schema}".workflow_status SET created_at = (SELECT created_at FROM "${schemas.schema}".workflow_status WHERE workflow_uuid = $1) WHERE workflow_uuid = $2`,
        [ids[0], ids[1]],
      )
    } finally {
      await client.end()
    }
    const [older, newer] = [...ids].sort() as [string, string]

    const listed = (await operations(scope.accountId, scope.projectContextId, base.extractionSchemaId)).map((operation) => operation.workflowId)
    expect(listed).toEqual([newer, older])
    expect((await remove(scope.accountId, newer)).status).toBe(204)
    expect(await statusOf(older)).toBeUndefined()
    expect(await statusOf(newer)).toBeUndefined()
  })

  it("a second account can neither list nor cancel nor discard the first account's operations", async () => {
    const alice = await seed()
    const bob = await seedInteractiveScope(packages)
    scopes.push(bob)
    const finished = await finishedGeneration(alice)
    const running = await runningGeneration(alice)

    const foreignListing = await listing(bob.accountId, alice.projectContextId)
    expect(foreignListing.status).toBe(404)
    await expect(foreignListing.json()).resolves.toEqual({ error: { code: 'not_found', message: 'Model operation was not found.' } })
    expect((await remove(bob.accountId, running.workflowId)).status).toBe(404)
    expect((await remove(bob.accountId, finished)).status).toBe(404)

    expect(await statusOf(running.workflowId)).toBe('PENDING')
    expect(await statusOf(finished)).toBe('SUCCESS')
    expect((await operations(alice.accountId, alice.projectContextId)).map((operation) => operation.workflowId)).toEqual([running.workflowId, finished])

    expect((await remove(alice.accountId, running.workflowId)).status).toBe(204)
    await until(async () => (await statusOf(running.workflowId)) === 'CANCELLED', 5_000, 'the workflow to be cancelled')
    expect((await running.response).status).toBe(409)
  })

  it('after the project is deleted, listing and DELETE are 404', async () => {
    const scope = await seed()
    const finished = await finishedGeneration(scope)
    expect((await operations(scope.accountId, scope.projectContextId)).map((operation) => operation.workflowId)).toEqual([finished])

    await db.orm.public.ProjectContext.where({ id: scope.projectContextId }).delete()

    expect((await listing(scope.accountId, scope.projectContextId)).status).toBe(404)
    expect((await remove(scope.accountId, finished)).status).toBe(404)
    // The history itself outlives the project until garbage collection (M6) removes it.
    expect(await statusOf(finished)).toBe('SUCCESS')
  })
})
