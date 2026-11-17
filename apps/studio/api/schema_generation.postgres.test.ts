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
  captureOutput,
  configureOwnerRoute,
  databaseHolds,
  removeInteractiveScope,
  seedInteractiveScope,
  type InteractiveScope,
} from '../test/support/interactive.js'
import { holdsKey, plantedKey } from '../test/support/plantedKey.js'
import { disposableDatabaseUrl, dropSchemas, testSchemas } from '../test/support/postgres.js'
import { startScriptedModelServer, type ScriptedModelServer } from '../test/support/scriptedModelServer.js'
import { suggestionResearcherStore } from '../test/support/suggestionWorkflow.js'
import { deploymentModels } from './_deployment_models.js'
import { generateSchemaWithModel } from './_schema_suggestion.js'
import { createModelKeyCache } from './_model_keys.js'
import { startOrJoinOperation } from './_model_operation.js'
import { registerSchemaGenerationWorkflow, type SchemaGenerationPorts } from './_schema_generation_workflow.js'
import { createPostGenerateSchema } from './generate_schema.js'

const url = disposableDatabaseUrl()
const scratch = mkdtempSync(join(tmpdir(), 'free-schema-generation-'))
const packageRoot = join(scratch, 'packages')
const packages = createCanonicalPackageStore(packageRoot)
const schemas = testSchemas()
const dropped: string[] = [schemas.schema, schemas.keiSchema]
const scopes: InteractiveScope[] = []
const TEMPLATE = '{"_description":"One catalogue entry.","title":"string"}'
/** A short wait for the model_key_required cases; the cancellation cases raise it so only a cancel can end the wait. */
let keyWaitMs = 400

let server: ScriptedModelServer
const keys = createModelKeyCache()
/** How many key waits began: a replayed step must start none. */
let waits = 0
const originalWait = keys.wait.bind(keys)
keys.wait = (...args) => {
  waits += 1
  return originalWait(...args)
}

const worker = createInternalProjectWorkerStore(db, { packages })
const ports: SchemaGenerationPorts = {
  steps: dbosSteps,
  readSource: (id) => worker.readRevisionSchemaSource(id),
  generate: (caller, input) =>
    generateSchemaWithModel(caller, input, undefined, { keys, keyWaitMs, deployment: deploymentModels({}) }),
}

function post(scope: InteractiveScope, operationId: string, fields: Record<string, string> = {}) {
  const form = new FormData()
  form.append('project_context_id', scope.projectContextId)
  form.append('source_representation_revision_id', scope.sourceRepresentationRevisionId)
  form.append('operation_id', operationId)
  form.append('instruction', 'Catalog entries')
  for (const [name, value] of Object.entries(fields)) form.set(name, value)
  const handler = createPostGenerateSchema(suggestionResearcherStore(scope.accountId), () => studioDbos().admission)
  return handler(new Request('http://local.test/api/generate_schema', { method: 'POST', body: form }))
}

async function seed(route: { hasKey: boolean; provider?: 'openai-compatible' | 'vllm'; modelId?: string; routes?: readonly ('interaction' | 'schemaSuggestion')[] }) {
  const scope = await seedInteractiveScope(packages)
  scopes.push(scope)
  const { connectionId } = await configureOwnerRoute(scope.accountId, {
    provider: route.provider ?? 'openai-compatible', baseUrl: server.baseUrl, modelId: route.modelId ?? 'scripted', hasKey: route.hasKey,
    ...(route.routes ? { routes: route.routes } : {}),
  }, keys)
  const address = { provider: route.provider ?? 'openai-compatible', baseUrl: server.baseUrl }
  return { scope, connectionId, putKey: (key: string) => keys.put(scope.accountId, connectionId, address, key) }
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

/** A crash child's environment: its own DBOS schemas and executor, shared by its two runs. */
function childEnv(scope: InteractiveScope, connectionId: string, key: string, operationId: string, extra: Record<string, string> = {}) {
  const names = testSchemas()
  dropped.push(names.schema, names.keiSchema)
  return {
    DATABASE_URL: url,
    FREE_TEST_DBOS_SCHEMA: names.schema,
    FREE_TEST_KEI_SCHEMA: names.keiSchema,
    FREE_TEST_EXECUTOR: names.executorId,
    FREE_TEST_PACKAGE_ROOT: packageRoot,
    FREE_TEST_ACCOUNT: scope.accountId,
    FREE_TEST_PROJECT: scope.projectContextId,
    FREE_TEST_REVISION: scope.sourceRepresentationRevisionId,
    FREE_TEST_OPERATION: operationId,
    FREE_TEST_CONNECTION: connectionId,
    FREE_TEST_MODEL_BASE: server.baseUrl,
    FREE_TEST_KEY: key,
    FREE_TEST_OUTPUT: join(scratch, `outcome-${operationId}.json`),
    FREE_TEST_WAIT_COUNT: join(scratch, `waits-${operationId}.txt`),
    FREE_CRASH_MARKER: join(scratch, `marker-${operationId}`),
    ...extra,
  }
}

/** Reads a crash child's own DBOS schema, which the in-process client never sees. */
async function childStatus(env: { FREE_TEST_DBOS_SCHEMA: string }, workflowId: string) {
  const client = await DBOSClient.create({ systemDatabaseUrl: url, systemDatabaseSchemaName: env.FREE_TEST_DBOS_SCHEMA, systemDatabasePoolSize: 1, applicationName: 'studio' })
  try {
    return (await client.getWorkflow(workflowId))?.status
  } finally {
    await client.destroy()
  }
}

/** The first run of a crash scenario, killed by this test once the scripted server holds its call. */
async function firstRunKilledInFlight(scenario: string, env: Record<string, string>, callIndex: number) {
  let kill: (() => void) | undefined
  const exited = runWorkflowChild(scenario, env, { spawned: (fn) => { kill = fn } })
  await server.waitForCall(callIndex, 30_000)
  kill!()
  const exit = await exited
  expect(exit.signal).toBe('SIGKILL')
}

beforeAll(async () => {
  server = await startScriptedModelServer()
  await launchStudioDbos({
    databaseUrl: url,
    ...schemas,
    register: () => registerSchemaGenerationWorkflow(() => ports),
  })
})

afterEach(() => {
  server.release()
  keys.clear()
  keyWaitMs = 400
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

describe('suggestSchema on PostgreSQL', () => {
  it('a generation runs as suggestion:<operationId> for the owner, and a repeated POST returns the same result without a second model call', async () => {
    const { scope } = await seed({ hasKey: false })
    const operationId = randomUUID()
    server.reply({ text: TEMPLATE })

    const [first, second] = await Promise.all([post(scope, operationId), post(scope, operationId)])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const body = await first.json()
    expect(body).toEqual({ template: { _description: 'One catalogue entry.', title: 'string' }, raw: TEMPLATE, pages: null, sourceCoverage: { complete: true } })
    expect(await second.json()).toEqual(body)
    expect(server.calls()).toHaveLength(1)
    const recorded = await studioDbos().admission.getWorkflow(`suggestion:${operationId}`)
    expect(recorded).toMatchObject({ status: 'SUCCESS', authenticatedUser: scope.accountId, workflowName: 'suggestSchema', queueName: 'studio' })
    // A third POST, after the fact, joins the finished workflow too.
    const third = await post(scope, operationId)
    expect(await third.json()).toEqual(body)
    expect(server.calls()).toHaveLength(1)
  })

  it('reusing an operation ID for a different instruction is 409 operation_conflict', async () => {
    const { scope } = await seed({ hasKey: false })
    const operationId = randomUUID()
    const callsBefore = server.calls().length
    server.reply({ text: TEMPLATE })
    expect((await post(scope, operationId)).status).toBe(200)

    const conflict = await post(scope, operationId, { instruction: 'Something else' })

    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: 'operation_conflict' } })
    expect(server.calls().length).toBe(callsBefore + 1)
    // The same ID under another workflow name: DBOS refuses the enqueue, and that is a conflict, not an outage.
    await expect(startOrJoinOperation(studioDbos().admission, {
      workflowName: 'proposeSchemaEdit', workflowID: `suggestion:${operationId}`, owner: scope.accountId, attributes: {}, input: { operationId },
    })).rejects.toMatchObject({ status: 409, code: 'operation_conflict' })
  })

  it('a first generation records extractionSchemaId null, and the scope filter finds it only by null', async () => {
    const { scope } = await seed({ hasKey: false })
    const operationId = randomUUID()
    server.reply({ text: TEMPLATE })
    expect((await post(scope, operationId)).status).toBe(200)

    const admission = studioDbos().admission
    const byNull = await admission.listWorkflows({ attributes: { projectContextId: scope.projectContextId, extractionSchemaId: null } })
    expect(byNull.map((status) => status.workflowID)).toEqual([`suggestion:${operationId}`])
    const bySchema = await admission.listWorkflows({ attributes: { projectContextId: scope.projectContextId, extractionSchemaId: randomUUID() } })
    expect(bySchema).toEqual([])
    const recorded = await admission.getWorkflow(`suggestion:${operationId}`)
    expect(recorded?.attributes).toEqual({
      projectContextId: scope.projectContextId, sourceDocumentId: scope.sourceDocumentId,
      sourceRepresentationRevisionId: scope.sourceRepresentationRevisionId, extractionSchemaId: null,
    })
  })

  it('a cancel during the key wait never reaches the provider', async () => {
    // A wait far longer than the test: only the cancel can end it.
    keyWaitMs = 60_000
    const { scope, putKey } = await seed({ hasKey: true })
    const operationId = randomUUID()
    const workflowId = `suggestion:${operationId}`
    const before = waits
    const callsBefore = server.calls().length
    const response = post(scope, operationId)

    await until(() => waits > before, 10_000, 'the key wait to begin')
    const cancelledAt = Date.now()
    await studioDbos().admission.cancelWorkflow(workflowId)
    await until(async () => (await statusOf(workflowId)) === 'CANCELLED', 3_000, 'the workflow to be cancelled')

    expect((await response).status).toBe(409)
    await expect((await response).clone().json()).resolves.toMatchObject({ error: { code: 'operation_cancelled' } })
    // The step's cancel signal ends the wait about 1 s after the cancel (spec): the workflow's step finishes long
    // before the 60 s wait would, and a key that arrives after it is never used.
    await until(async () => (await studioDbos().admission.getWorkflow(workflowId))?.recoveryAttempts !== undefined
      && Date.now() - cancelledAt > 1_500, 5_000, 'the cancel signal to fire')
    putKey('sk-test-late')
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(server.calls().length).toBe(callsBefore)
    expect(await statusOf(workflowId)).toBe('CANCELLED')
    expect(Date.now() - cancelledAt).toBeLessThan(10_000)
  })

  it('a cancel during a provider call stops it about 1 s later', async () => {
    const { scope, putKey } = await seed({ hasKey: true })
    putKey('sk-test-present')
    const operationId = randomUUID()
    const workflowId = `suggestion:${operationId}`
    const callsBefore = server.calls().length
    server.reply({ text: TEMPLATE, hold: true })
    const response = post(scope, operationId)

    const call = await server.waitForCall(callsBefore + 1)
    expect(call.authorization).toBe('Bearer sk-test-present')
    const cancelledAt = Date.now()
    await studioDbos().admission.cancelWorkflow(workflowId)
    await until(async () => (await statusOf(workflowId)) === 'CANCELLED', 5_000, 'the workflow to be cancelled')
    await until(() => server.calls()[callsBefore]!.closedAt !== null, 5_000, 'the held call to close')

    expect(server.calls()[callsBefore]!.closedAt! - cancelledAt).toBeLessThanOrEqual(2_500)
    expect((await response).status).toBe(409)
  })

  it('a key planted in a provider error in a JSON step reaches no DBOS or public table and no log', async () => {
    const { scope, putKey } = await seed({ hasKey: true })
    const key = plantedKey()
    putKey(key)
    const output = captureOutput()
    let failed: Response
    let succeeded: Response
    try {
      // 401 is what a provider answers a bad key with, and the SDK does not retry it; its body and headers echo the key.
      server.reply({ status: 401, body: '{"error":{"message":"Incorrect API key: {{authorization}}"}}', headers: { 'x-echo': key } })
      failed = await post(scope, randomUUID())
      server.reply({ text: TEMPLATE, headers: { 'x-echo': key } })
      succeeded = await post(scope, randomUUID())
    } finally {
      output.restore()
    }

    expect(failed.status).toBe(502)
    const failure = await failed.json()
    expect(failure).toMatchObject({ error: { code: 'model_operation_failed' } })
    expect(holdsKey(failure, key)).toBe(false)
    expect(succeeded.status).toBe(200)
    expect(holdsKey(await succeeded.json(), key)).toBe(false)
    expect(server.calls().slice(-2).every((call) => call.authorization === `Bearer ${key}`), 'both calls carried the planted key').toBe(true)
    expect(await databaseHolds(url, key, [schemas.schema, 'public'])).toEqual([])
    expect(output.text()).not.toContain(key)
  })

  it('the log capture sees a key nested in a logged error (negative control for the scan above)', () => {
    const key = plantedKey()
    const output = captureOutput()
    try {
      console.error('provider failed:', new Error('harmless', { cause: { responseHeaders: { 'x-echo': key } } }))
    } finally {
      output.restore()
    }
    expect(output.text()).toContain(key)
  })

  it('NuExtract on a keyed vLLM connection waits for its key, stops on cancel, and leaves no key in history', async () => {
    const { scope, putKey } = await seed({ hasKey: true, provider: 'vllm', modelId: 'numind/NuExtract3-FP8', routes: ['schemaSuggestion'] })
    const callsBefore = server.calls().length

    // No key and no page: model_key_required after the wait, no call.
    const missing = await post(scope, randomUUID())
    expect(missing.status).toBe(409)
    await expect(missing.json()).resolves.toMatchObject({ error: { code: 'model_key_required' } })
    expect(server.calls().length).toBe(callsBefore)

    // A cancel during a long wait: only the cancel can end it, and no call is made.
    keyWaitMs = 60_000
    const cancelledId = randomUUID()
    const before = waits
    const cancelled = post(scope, cancelledId)
    await until(() => waits > before, 10_000, 'the key wait to begin')
    const cancelledAt = Date.now()
    await studioDbos().admission.cancelWorkflow(`suggestion:${cancelledId}`)
    expect((await cancelled).status).toBe(409)
    await expect((await cancelled).clone().json()).resolves.toMatchObject({ error: { code: 'operation_cancelled' } })
    expect(await statusOf(`suggestion:${cancelledId}`)).toBe('CANCELLED')
    expect(server.calls().length).toBe(callsBefore)
    // Let the step's cancel signal end the wait (about 1 s) before a key arrives.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(Date.now() - cancelledAt).toBeLessThan(10_000)
    keyWaitMs = 400

    // The key present and a provider error that echoes it: no key in any table.
    const key = plantedKey()
    putKey(key)
    server.reply({ status: 401, body: '{"error":"{{authorization}}"}', headers: { 'x-echo': key } })
    const failed = await post(scope, randomUUID())
    expect(failed.status).toBe(502)
    expect(holdsKey(await failed.json(), key)).toBe(false)
    expect(await databaseHolds(url, key, [schemas.schema, 'public'])).toEqual([])

    // The key present and a success: the call carried it as a bearer token.
    server.reply({ text: TEMPLATE })
    const succeeded = await post(scope, randomUUID())
    expect(succeeded.status).toBe(200)
    expect(server.calls().at(-1)?.authorization === `Bearer ${key}`, 'the last call carried the planted key').toBe(true)
    expect(server.calls().length).toBe(callsBefore + 2)

    // A cancel during NuExtract's own fetch stops it about 1 s later, like the SDK models (A15).
    const heldId = randomUUID()
    server.reply({ text: TEMPLATE, hold: true })
    const held = post(scope, heldId)
    await server.waitForCall(callsBefore + 3)
    const heldCancelledAt = Date.now()
    await studioDbos().admission.cancelWorkflow(`suggestion:${heldId}`)
    await until(() => server.calls()[callsBefore + 2]!.closedAt !== null, 5_000, 'the held NuExtract call to close')
    expect(server.calls()[callsBefore + 2]!.closedAt! - heldCancelledAt).toBeLessThanOrEqual(2_500)
    expect((await held).status).toBe(409)
    expect(await statusOf(`suggestion:${heldId}`)).toBe('CANCELLED')
  })

  it('a replayed step whose call is checkpointed never waits for a key, even after the route moved', async () => {
    const { scope, connectionId } = await seed({ hasKey: true })
    const key = plantedKey()
    const operationId = randomUUID()
    const env = childEnv(scope, connectionId, key, operationId)
    const callsBefore = server.calls().length
    server.reply({ text: TEMPLATE })

    const first = await runWorkflowChild('generation-replay', env)
    expect(first.signal).toBe('SIGKILL')
    expect(server.calls().length).toBe(callsBefore + 1)
    // Between the runs the owner's Schema Suggestion Route moves to a second server that must see no call.
    const other = await startScriptedModelServer()
    try {
      const moved = await configureOwnerRoute(scope.accountId, { provider: 'openai-compatible', baseUrl: other.baseUrl, modelId: 'scripted', hasKey: true }, keys)
      const second = await runWorkflowChild('generation-replay', { ...env, FREE_TEST_CONNECTION: moved.connectionId, FREE_TEST_MODEL_BASE: other.baseUrl, FREE_TEST_RESEND: '0' })
      expect(second.code).toBe(0)
      expect(JSON.parse(readFileSync(env.FREE_TEST_OUTPUT, 'utf8'))).toEqual({
        state: 'finished',
        output: { ok: true, template: { _description: 'One catalogue entry.', title: 'string' }, raw: TEMPLATE, pages: null, sourceCoverage: { complete: true }, baseSchemaRevisionId: null },
      })
      expect(readFileSync(env.FREE_TEST_WAIT_COUNT, 'utf8')).toBe('0')
      expect(other.calls()).toEqual([])
      expect(server.calls().length).toBe(callsBefore + 1)
    } finally {
      await other.close()
    }
  })

  it('a Studio killed mid-generation recovers it: the operation stays listed as running, and finishes once the page resends the key', async () => {
    const { scope, connectionId } = await seed({ hasKey: true })
    const key = plantedKey()
    const operationId = randomUUID()
    const env = childEnv(scope, connectionId, key, operationId)
    const callsBefore = server.calls().length
    server.reply({ text: '{"_description":"First attempt.","a":"string"}', hold: true })

    await firstRunKilledInFlight('generation-recover', env, callsBefore + 1)
    server.release()
    expect(await childStatus(env, `suggestion:${operationId}`)).toBe('PENDING')

    server.reply({ text: TEMPLATE })
    const second = await runWorkflowChild('generation-recover', env)
    expect(second.code).toBe(0)
    expect(JSON.parse(readFileSync(env.FREE_TEST_OUTPUT, 'utf8'))).toMatchObject({ state: 'finished', output: { ok: true, raw: TEMPLATE } })
    expect(server.calls().length).toBe(callsBefore + 2)
    expect(server.calls().slice(-2).every((call) => call.authorization === `Bearer ${key}`), 'both calls carried the planted key').toBe(true)
  })

  it('a route changed between attempts: an interrupted generation reruns on the new route', async () => {
    const { scope, connectionId } = await seed({ hasKey: true })
    const key = plantedKey()
    const operationId = randomUUID()
    const env = childEnv(scope, connectionId, key, operationId)
    const callsBefore = server.calls().length
    server.reply({ text: '{"_description":"First attempt.","a":"string"}', hold: true })

    await firstRunKilledInFlight('generation-recover', env, callsBefore + 1)
    server.release()
    const other = await startScriptedModelServer()
    try {
      other.reply({ text: TEMPLATE })
      const moved = await configureOwnerRoute(scope.accountId, { provider: 'openai-compatible', baseUrl: other.baseUrl, modelId: 'scripted', hasKey: true }, keys)
      const second = await runWorkflowChild('generation-recover', { ...env, FREE_TEST_CONNECTION: moved.connectionId, FREE_TEST_MODEL_BASE: other.baseUrl })
      expect(second.code).toBe(0)
      expect(JSON.parse(readFileSync(env.FREE_TEST_OUTPUT, 'utf8'))).toMatchObject({ state: 'finished', output: { ok: true, raw: TEMPLATE } })
      expect(server.calls().length).toBe(callsBefore + 1)
      expect(other.calls()).toHaveLength(1)
      expect(other.calls()[0]?.authorization === `Bearer ${key}`, 'the call on the new route carried the planted key').toBe(true)
    } finally {
      await other.close()
    }
  })

  it('with no page to resend it, a recovered generation fails with model_key_required after the wait and nobody retries it', async () => {
    const { scope, connectionId } = await seed({ hasKey: true })
    const key = plantedKey()
    const operationId = randomUUID()
    const env = childEnv(scope, connectionId, key, operationId, { FREE_TEST_RESEND: '0', FREE_TEST_KEY_WAIT_MS: '500' })
    const callsBefore = server.calls().length
    server.reply({ text: '{"_description":"First attempt.","a":"string"}', hold: true })

    await firstRunKilledInFlight('generation-recover', env, callsBefore + 1)
    server.release()
    const second = await runWorkflowChild('generation-recover', env)

    expect(second.code).toBe(0)
    expect(JSON.parse(readFileSync(env.FREE_TEST_OUTPUT, 'utf8'))).toMatchObject({
      state: 'finished', output: { ok: false, status: 409, code: 'model_key_required' },
    })
    expect(readFileSync(env.FREE_TEST_WAIT_COUNT, 'utf8')).toBe('1')
    expect(server.calls().length).toBe(callsBefore + 1)
    expect(await childStatus(env, `suggestion:${operationId}`)).toBe('SUCCESS')
  })
})
