import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DBOSClient } from '@dbos-inc/dbos-sdk'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createInternalProjectWorkerStore, db, pool } from 'db'
import { dbosSteps } from 'extraction'
import { createCanonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import { launchStudioDbos, shutdownStudioDbos, studioDbos } from '../server/dbos.js'
import { runWorkflowChild } from '../test/support/crash.js'
import {
  configureOwnerRoute,
  removeInteractiveScope,
  seedInteractiveScope,
  seedSchemaRevision,
  type InteractiveScope,
} from '../test/support/interactive.js'
import { plantedKey } from '../test/support/plantedKey.js'
import { disposableDatabaseUrl, dropSchemas, testSchemas } from '../test/support/postgres.js'
import { startScriptedModelServer, type ScriptedModelServer } from '../test/support/scriptedModelServer.js'
import { suggestionResearcherStore } from '../test/support/suggestionWorkflow.js'
import { deploymentModels } from './_deployment_models.js'
import { generateSchemaEditJson } from './_model.js'
import { createModelKeyCache } from './_model_keys.js'
import { proposeSchemaEdit } from './_schema_edit.js'
import { registerSchemaEditWorkflow, type SchemaEditPorts } from './_schema_edit_workflow.js'
import { createPostEditSchema } from './edit_schema.js'

const url = disposableDatabaseUrl()
const scratch = mkdtempSync(join(tmpdir(), 'free-schema-edit-'))
const packageRoot = join(scratch, 'packages')
const packages = createCanonicalPackageStore(packageRoot)
const schemas = testSchemas()
const dropped: string[] = [schemas.schema, schemas.keiSchema]
const scopes: InteractiveScope[] = []
const ENVELOPE = '{"fields":{},"additions":[]}'
const PROPOSED = { status: 'proposed', fields: {}, additions: [], issues: [] }

let server: ScriptedModelServer
const keys = createModelKeyCache()
const worker = createInternalProjectWorkerStore(db, { packages })
const ports: SchemaEditPorts = {
  steps: dbosSteps,
  readSchemaTree: (schemaId, revisionId) => worker.readSchemaRevisionTree(schemaId, revisionId),
  readMarkdown: (id) => worker.readRevisionMarkdown(id),
  propose: proposeSchemaEdit,
  generateJson: (caller, prompt, temperature, signal, target) =>
    generateSchemaEditJson(caller, prompt, temperature, signal, target, { keys, keyWaitMs: 400, deployment: deploymentModels({}) }),
}

type Base = { extractionSchemaId: string; schemaRevisionId: string }

function post(scope: InteractiveScope, base: Base, operationId: string, options: { grounded?: boolean; instruction?: string } = {}) {
  const form = new FormData()
  form.append('project_context_id', scope.projectContextId)
  form.append('extraction_schema_id', base.extractionSchemaId)
  form.append('schema_revision_id', base.schemaRevisionId)
  if (options.grounded ?? true) form.append('source_representation_revision_id', scope.sourceRepresentationRevisionId)
  form.append('operation_id', operationId)
  form.append('instruction', options.instruction ?? 'Rename title to heading')
  const handler = createPostEditSchema(suggestionResearcherStore(scope.accountId), () => studioDbos().admission)
  return handler(new Request('http://local.test/api/edit_schema', { method: 'POST', body: form }))
}

async function seed(hasKey: boolean) {
  const scope = await seedInteractiveScope(packages)
  scopes.push(scope)
  const base = await seedSchemaRevision(scope)
  const { connectionId } = await configureOwnerRoute(scope.accountId, { provider: 'openai-compatible', baseUrl: server.baseUrl, modelId: 'scripted', hasKey }, keys)
  return { scope, base, connectionId }
}

async function childStatus(env: { FREE_TEST_DBOS_SCHEMA: string }, workflowId: string) {
  const client = await DBOSClient.create({ systemDatabaseUrl: url, systemDatabaseSchemaName: env.FREE_TEST_DBOS_SCHEMA, systemDatabasePoolSize: 1, applicationName: 'studio' })
  try {
    return (await client.getWorkflow(workflowId))?.status
  } finally {
    await client.destroy()
  }
}

beforeAll(async () => {
  server = await startScriptedModelServer()
  await launchStudioDbos({ databaseUrl: url, ...schemas, register: () => registerSchemaEditWorkflow(() => ports) })
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
      await dropSchemas(url, ...dropped)
    } finally {
      await server.close()
      await db.close()
      await pool.end()
      rmSync(scratch, { recursive: true, force: true })
    }
  }
})

describe('proposeSchemaEdit on PostgreSQL', () => {
  it('an edit runs as edit:<operationId>, and a repeated POST returns the same proposal without a second model call', async () => {
    const { scope, base } = await seed(false)
    const operationId = randomUUID()
    const callsBefore = server.calls().length
    server.reply({ text: ENVELOPE })

    const [first, second] = await Promise.all([post(scope, base, operationId), post(scope, base, operationId)])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    await expect(first.json()).resolves.toEqual(PROPOSED)
    await expect(second.json()).resolves.toEqual(PROPOSED)
    expect(server.calls().length).toBe(callsBefore + 1)
    const recorded = await studioDbos().admission.getWorkflow(`edit:${operationId}`)
    expect(recorded).toMatchObject({ status: 'SUCCESS', authenticatedUser: scope.accountId, workflowName: 'proposeSchemaEdit', queueName: 'studio' })
    expect(recorded?.attributes).toEqual({
      projectContextId: scope.projectContextId, extractionSchemaId: base.extractionSchemaId,
      sourceDocumentId: scope.sourceDocumentId, sourceRepresentationRevisionId: scope.sourceRepresentationRevisionId,
    })
    expect(recorded?.output).toEqual({ ok: true, baseSchemaRevisionId: base.schemaRevisionId, response: PROPOSED })
  })

  it('a Studio killed mid-proposal recovers it: the operation stays listed as running and finishes with a proposal on its base', async () => {
    const { scope, base, connectionId } = await seed(true)
    const key = plantedKey()
    const operationId = randomUUID()
    const names = testSchemas()
    dropped.push(names.schema, names.keiSchema)
    const env = {
      DATABASE_URL: url,
      FREE_TEST_DBOS_SCHEMA: names.schema,
      FREE_TEST_KEI_SCHEMA: names.keiSchema,
      FREE_TEST_EXECUTOR: names.executorId,
      FREE_TEST_PACKAGE_ROOT: packageRoot,
      FREE_TEST_ACCOUNT: scope.accountId,
      FREE_TEST_PROJECT: scope.projectContextId,
      FREE_TEST_REVISION: scope.sourceRepresentationRevisionId,
      FREE_TEST_SCHEMA: base.extractionSchemaId,
      FREE_TEST_BASE_REVISION: base.schemaRevisionId,
      FREE_TEST_OPERATION: operationId,
      FREE_TEST_CONNECTION: connectionId,
      FREE_TEST_MODEL_BASE: server.baseUrl,
      FREE_TEST_KEY: key,
      FREE_TEST_OUTPUT: join(scratch, `outcome-${operationId}.json`),
      FREE_TEST_WAIT_COUNT: join(scratch, `waits-${operationId}.txt`),
      FREE_CRASH_MARKER: join(scratch, `marker-${operationId}`),
    }
    const callsBefore = server.calls().length
    server.reply({ text: ENVELOPE, hold: true })

    let kill: (() => void) | undefined
    const exited = runWorkflowChild('edit-recover', env, { spawned: (fn) => { kill = fn } })
    await server.waitForCall(callsBefore + 1, 30_000)
    kill!()
    expect((await exited).signal).toBe('SIGKILL')
    server.release()
    expect(await childStatus(env, `edit:${operationId}`)).toBe('PENDING')

    server.reply({ text: ENVELOPE })
    const second = await runWorkflowChild('edit-recover', env)
    expect(second.code).toBe(0)
    expect(JSON.parse(readFileSync(env.FREE_TEST_OUTPUT, 'utf8'))).toEqual({
      state: 'finished', output: { ok: true, baseSchemaRevisionId: base.schemaRevisionId, response: PROPOSED },
    })
    expect(server.calls().length).toBe(callsBefore + 2)
    expect(server.calls().slice(-2).every((call) => call.authorization === `Bearer ${key}`), 'both calls carried the planted key').toBe(true)
    expect(await childStatus(env, `edit:${operationId}`)).toBe('SUCCESS')
  })

  it('a schema-only edit records only the project and schema attributes', async () => {
    const { scope, base } = await seed(false)
    const operationId = randomUUID()
    server.reply({ text: ENVELOPE })

    const response = await post(scope, base, operationId, { grounded: false })

    expect(response.status).toBe(200)
    const recorded = await studioDbos().admission.getWorkflow(`edit:${operationId}`)
    expect(recorded?.attributes).toEqual({ projectContextId: scope.projectContextId, extractionSchemaId: base.extractionSchemaId })
    expect(recorded?.input?.[0]).toMatchObject({ sourceRepresentationRevisionId: null, baseSchemaRevisionId: base.schemaRevisionId })
  })
})
