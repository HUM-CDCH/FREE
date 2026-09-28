import type { Database } from 'db'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import type { ExtractionExecution } from './dependencies.js'
import { ExtractionError } from './errors.js'
import { keiExtractWorkflowId, type KeiExtractInput } from './kei-handoff.js'
import { createExtractionModule } from './module.js'
import { fixture } from './testing/extraction-fixture.js'
import { RUN_EXTRACTION } from './workflows.js'

describe('Extraction admission on disposable PostgreSQL', { skip: !fixture && 'set EXTRACTION_TEST_DATABASE_URL (or DATABASE_URL) to a migrated disposable free_test_* database' }, () => {
  if (!fixture) return
  const {
    db, createResearcherExtractionPersistence, packages, kei, app,
    execution, deterministicArtifact, seedProject, scheduler, createRuntime,
    freshInput, heldByKei, extractionRow, cleanup,
  } = fixture

  it('admits an Extraction row and its runExtraction workflow in one transaction', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const module = scheduler(project.researcherAccountId)
    kei.holding = true
    const models = { fields: 'nuextract' }
    const input = {
      ...freshInput(project), strategy: 'CATALOG' as const, catalogRecipe: 'numbered-catalogue-de@1', models,
    }
    const admitted = await module.runSingle(input)
    assert.equal(admitted.disposition, 'created')
    // The workflow was enqueued in the transaction that committed the row.
    assert.equal(admitted.extraction.executionStatus, 'QUEUED')
    const row = await extractionRow(input.extractionId)
    assert.equal(row?.outcome, null)
    assert.equal(row?.catalogRecipe, 'numbered-catalogue-de@1')
    assert.deepEqual(row?.requestedModels, models)
    const document = project.documents[0]!
    const [workflow] = await app.admission.listWorkflows({ workflowIDs: [`extract:${input.extractionId}`], loadInput: true })
    assert.equal(workflow?.workflowName, RUN_EXTRACTION)
    assert.equal(workflow?.queueName, 'studio')
    assert.equal(workflow?.authenticatedUser, project.researcherAccountId)
    assert.deepEqual(workflow?.input, [input.extractionId])
    assert.deepEqual(workflow?.attributes, {
      projectContextId: project.projectContextId,
      sourceDocumentId: document.sourceDocumentId,
      sourceRepresentationRevisionId: document.sourceRepresentationRevisionId,
      extractionSchemaId: project.extractionSchemaId,
      keiRunId: document.runId,
    })
    await heldByKei(input.extractionId)
  })

it('a failure after the enqueue rolls back both the row and the workflow', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const failing: ExtractionExecution = {
      ...execution,
      async enqueue(client, workflow, input) {
        await execution.enqueue(client, workflow, input)
        throw new Error('the request failed after its enqueue')
      },
    }
    const module = createExtractionModule(
      createResearcherExtractionPersistence(project.researcherAccountId, failing, { database: db as Database, packages }),
    )
    const input = freshInput(project)
    await assert.rejects(module.runSingle(input), /after its enqueue/)
    assert.equal(await extractionRow(input.extractionId), null)
    assert.deepEqual(await app.admission.listWorkflows({ workflowIDs: [`extract:${input.extractionId}`] }), [])
  })

it('stores the Catalog recipe chosen for an Extraction on its row and hands it to kei', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const module = scheduler(project.researcherAccountId)
    kei.holding = true
    const extractionId = randomUUID()
    const input = { ...freshInput(project, extractionId), strategy: 'CATALOG' as const,
                    catalogRecipe: 'numbered-catalogue-de@1' }
    // Every read of the attempt names its recipe, so a failed attempt can be run again with it.
    assert.equal((await module.runSingle(input)).extraction.catalogRecipe, 'numbered-catalogue-de@1')
    assert.equal((await module.runSingle(input)).disposition, 'replayed')
    assert.equal((await module.readExtractionAttempt(extractionId))?.catalogRecipe, 'numbered-catalogue-de@1')
    await assert.rejects(module.runSingle({ ...input, catalogRecipe: null }),
      (error: unknown) => error instanceof ExtractionError && error.code === 'extraction_id_conflict')
    assert.equal((await extractionRow(extractionId))?.catalogRecipe, 'numbered-catalogue-de@1')
    await heldByKei(extractionId)
    const request = kei.submissions.find((submission) => submission.workflowId === keiExtractWorkflowId(extractionId))!
      .request as KeiExtractInput
    assert.deepEqual(request.request.options, { strategy: 'catalog', catalog: { recipe: 'numbered-catalogue-de@1' } })
  })

it('keeps the Extraction Model Choice on its row, hands it to kei, and records the model each role ran on', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    kei.respond = (request) => ({
      artifact: { ...deterministicArtifact(request), models: { fields: 'numind/NuExtract3-FP8', reasoning: 'Qwen/Qwen3.8-27B-FP8' } },
    })
    const { module, scheduled } = createRuntime(project.researcherAccountId)
    const models = { fields: 'nuextract', reasoning: 'instruct' }
    const input = { ...freshInput(project), models }
    const queued = await scheduled.runSingle(input)
    assert.deepEqual(queued.extraction.requestedModels, models)
    // A replay must ask for the same models: another choice under the same id is another Extraction.
    for (const other of [null, {}, { fields: 'nuextract' }, { fields: 'instruct', reasoning: 'instruct' }])
      await assert.rejects(module.runSingle({ ...input, models: other }),
        (error: unknown) => error instanceof ExtractionError && error.code === 'extraction_id_conflict')
    const created = await module.runSingle({ ...input, models: { reasoning: 'instruct', fields: 'nuextract' } })
    assert.equal(created.disposition, 'replayed')
    assert.equal(created.extraction.outcome, 'SUCCEEDED')
    assert.deepEqual(kei.submissions.map((submission) => (submission.request as KeiExtractInput).request.options.models), [models])
    assert.deepEqual(created.extraction.requestedModels, models)
    assert.deepEqual(created.extraction.diagnostics?.models,
      { fields: 'numind/NuExtract3-FP8', reasoning: 'Qwen/Qwen3.8-27B-FP8' })
    assert.deepEqual(created.extraction.modelAttribution, { provider: 'kei-exp', modelId: 'deterministic' })
    assert.deepEqual((await extractionRow(input.extractionId))?.requestedModels, models)
    const reopened = await module.readDocumentExtractions({ sourceDocumentId: project.documents[0]!.sourceDocumentId })
    assert.deepEqual(reopened?.latestAttempt?.requestedModels, models)
  })

it('stores no Extraction Model Choice when every role keeps kei-exp\'s defaults', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const { module } = createRuntime(project.researcherAccountId)
    for (const models of [undefined, null, {}]) {
      const input = { ...freshInput(project), models }
      const created = await module.runSingle(input)
      assert.equal(created.extraction.requestedModels, null)
      // No choice and an empty choice are the same request.
      assert.equal((await module.runSingle({ ...input, models: {} })).disposition, 'replayed')
      assert.equal((await extractionRow(input.extractionId))?.requestedModels, null)
    }
    assert.deepEqual(kei.submissions.map((submission) => (submission.request as KeiExtractInput).request.options.models ?? null),
      [null, null, null])
  })
})
