import type { Database } from 'db'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import type { ExtractionExecution } from './dependencies.js'
import { ExtractionError } from './errors.js'
import { REFERENCE_ARTICLE } from './extraction-method.js'
import { keiExtractWorkflowId, type KeiExtractInput } from './kei-handoff.js'
import { createExtractionModule } from './module.js'
import { fixture } from './testing/extraction-fixture.js'
import { RUN_EXTRACTION } from './workflows.js'

describe('Extraction admission on disposable PostgreSQL', { skip: !fixture && 'set EXTRACTION_TEST_DATABASE_URL (or DATABASE_URL) to a migrated disposable free_test_* database' }, () => {
  if (!fixture) return
  const {
    db, createResearcherExtractionPersistence, packages, kei, app,
    execution, deterministicArtifact, seedProject, scheduler, createRuntime,
    freshInput, heldByKei, extractionRow, cleanup, configureAccount, modelConfigurations, rejectsWithCode,
    untilLockWait, untilSignalled,
  } = fixture

  it('admits an Extraction row and its runExtraction workflow in one transaction', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const module = scheduler(project.researcherAccountId)
    kei.holding = true
    const models = { fields: 'nuextract' }
    await configureAccount(project.researcherAccountId, { extractionModels: models })
    const input = {
      ...freshInput(project), strategy: 'CATALOG' as const, catalogRecipe: 'numbered-catalogue-de@1',
      method: { models, settings: { recipe: null } },
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
                    catalogRecipe: 'numbered-catalogue-de@1', method: { models: null, settings: { recipe: null } } }
    // Every read of the attempt names its recipe, so a failed attempt can be run again with it.
    assert.equal((await module.runSingle(input)).extraction.catalogRecipe, 'numbered-catalogue-de@1')
    assert.equal((await module.runSingle(input)).disposition, 'replayed')
    assert.equal((await module.readExtractionAttempt(extractionId))?.catalogRecipe, 'numbered-catalogue-de@1')
    await assert.rejects(module.runSingle({ ...input, catalogRecipe: null, method: { models: null, settings: { generic: null } } }),
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
    await configureAccount(project.researcherAccountId, { extractionModels: models })
    const input = freshInput(project, randomUUID(), { models, settings: { article: null } })
    const queued = await scheduled.runSingle(input)
    assert.deepEqual(queued.extraction.requestedModels, models)
    // A replay must ask for the same models: another choice under the same id is another Extraction.
    for (const other of [null, { fields: 'nuextract' }, { fields: 'instruct', reasoning: 'instruct' }])
      await assert.rejects(module.runSingle({ ...input, method: { models: other, settings: { article: null } } }),
        (error: unknown) => error instanceof ExtractionError && error.code === 'extraction_id_conflict')
    const created = await module.runSingle({
      ...input, method: { models: { reasoning: 'instruct', fields: 'nuextract' }, settings: { article: null } },
    })
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
    for (const models of [null, {}]) {
      const input = freshInput(project, randomUUID(), { models, settings: { article: null } })
      const created = await module.runSingle(input)
      assert.equal(created.extraction.requestedModels, null)
      // No choice and an empty choice are the same request.
      assert.equal((await module.runSingle({ ...input, method: { models: {}, settings: { article: null } } })).disposition,
        'replayed')
      assert.equal((await extractionRow(input.extractionId))?.requestedModels, null)
    }
    assert.deepEqual(kei.submissions.map((submission) => (submission.request as KeiExtractInput).request.options.models ?? null),
      [null, null])
  })

  const SPANS = {
    context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
    prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema',
  } as const
  const QUOTES = { ...SPANS, grounding: 'quoted' } as const
  const intent = (article: unknown, models: Record<string, string> | null = null) => ({ models, settings: { article } }) as never

  it('pins the saved method on the row it admits, with the models', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    kei.holding = true
    await configureAccount(project.researcherAccountId, { extractionModels: { fields: 'instruct' }, extractionSettings: { article: SPANS } })
    const input = freshInput(project, randomUUID(), intent(SPANS, { fields: 'instruct' }))
    assert.equal((await scheduler(project.researcherAccountId).runSingle(input)).disposition, 'created')
    const row = await extractionRow(input.extractionId)
    assert.deepEqual(row?.requestedSettings, { article: SPANS })
    assert.deepEqual(row?.requestedModels, { fields: 'instruct' })
    await heldByKei(input.extractionId)
  })

  it('a start preview that no longer matches the saved method admits nothing', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: QUOTES } })
    const input = freshInput(project, randomUUID(), intent(SPANS))
    await assert.rejects(scheduler(project.researcherAccountId).runSingle(input), rejectsWithCode('method_changed'))
    assert.equal(await extractionRow(input.extractionId), null)
    assert.deepEqual(await app.admission.listWorkflows({ workflowIDs: [`extract:${input.extractionId}`] }), [])
  })

  it("a method naming another strategy's settings is refused before anything is admitted", async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const input = freshInput(project, randomUUID(), { models: null, settings: { generic: null } })
    await assert.rejects(scheduler(project.researcherAccountId).runSingle(input), (error: unknown) =>
      error instanceof ExtractionError && error.code === 'invalid_request' &&
      error.message === 'The saved method does not fit this Extraction Strategy.')
    assert.equal(await extractionRow(input.extractionId), null)
  })

  it('a saved document admission cannot read refuses the start instead of running on defaults', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    await modelConfigurations.apply(project.researcherAccountId, () => ({ extractionModels: {}, extractionSettings: { article: 'spans' } }))
    const input = freshInput(project)
    await assert.rejects(scheduler(project.researcherAccountId).runSingle(input), rejectsWithCode('invalid_model_config'))
    assert.equal(await extractionRow(input.extractionId), null)
  })

  it('a lost response replays with its stored method after the account changes; another descriptor under the ID conflicts', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    kei.holding = true
    const module = scheduler(project.researcherAccountId)
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: SPANS } })
    const input = freshInput(project, randomUUID(), intent(SPANS))
    assert.equal((await module.runSingle(input)).disposition, 'created')
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: QUOTES } })
    // The retry resolves the admitted Extraction before today's defaults are consulted.
    assert.equal((await module.runSingle(input)).disposition, 'replayed')
    for (const other of [intent(QUOTES), intent(null), intent(REFERENCE_ARTICLE)])
      await assert.rejects(module.runSingle({ ...input, method: other }), rejectsWithCode('extraction_id_conflict'))
    assert.equal((await app.admission.listWorkflows({ workflowIDs: [`extract:${input.extractionId}`] })).length, 1)
    assert.deepEqual((await extractionRow(input.extractionId))?.requestedSettings, { article: SPANS })
    await heldByKei(input.extractionId)
  })

  it('explicit reference and service defaults are different requests under one ID', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    kei.holding = true
    const module = scheduler(project.researcherAccountId)
    const input = freshInput(project)
    assert.equal((await module.runSingle(input)).disposition, 'created')
    await assert.rejects(module.runSingle({ ...input, method: intent(REFERENCE_ARTICLE) }), rejectsWithCode('extraction_id_conflict'))
    assert.deepEqual((await extractionRow(input.extractionId))?.requestedSettings, { article: null })
    await heldByKei(input.extractionId)
  })

  it('an Extraction admitted before settings were recorded is never the same request', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    kei.holding = true
    const module = scheduler(project.researcherAccountId)
    const input = freshInput(project)
    await module.runSingle(input)
    await db.orm.public.Extraction.where({ id: input.extractionId }).update({ requestedSettings: null })
    await assert.rejects(module.runSingle(input), rejectsWithCode('extraction_id_conflict'))
    await heldByKei(input.extractionId)
  })

  it('changing only Catalog settings does not make an Article preview stale', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    kei.holding = true
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: SPANS } })
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: SPANS, catalog: { generic: { record_chars: 30000 } } } })
    const input = freshInput(project, randomUUID(), intent(SPANS))
    assert.equal((await scheduler(project.researcherAccountId).runSingle(input)).disposition, 'created')
    await heldByKei(input.extractionId)
  })

  it('identity fields the pinned schema lacks refuse the start before anything is enqueued, by exact name', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    // The schema has `title`: `Title` differs only by case and is never case-folded into it.
    const declared = { ...REFERENCE_ARTICLE, identity: 'conservative', identity_fields: ['Title', 'filename'] }
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: declared } })
    const input = freshInput(project, randomUUID(), intent(declared))
    await assert.rejects(scheduler(project.researcherAccountId).runSingle(input), (error: unknown) =>
      error instanceof ExtractionError && error.code === 'invalid_identity_fields' &&
      error.message === 'These identity fields are not scalar record fields of the selected Schema Revision: Title (not in this schema), filename (taken from the source’s filename).')
    assert.equal(await extractionRow(input.extractionId), null)
    assert.deepEqual(await app.admission.listWorkflows({ workflowIDs: [`extract:${input.extractionId}`] }), [])
    assert.equal(kei.submissions.length, 0)
  })

  it('an Apply in flight commits before the admission compares; the admission then refuses the stale preview', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: SPANS } })
    const locked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    // `next` runs once the Apply's upsert holds the configuration row's lock, so entering it is the Apply's signal.
    const applying = modelConfigurations.apply(project.researcherAccountId, async (previous) => {
      locked.resolve()
      await release.promise
      return { ...(previous as object), extractionSettings: { article: QUOTES } }
    })
    const input = freshInput(project, randomUUID(), intent(SPANS))
    let admitting: Promise<unknown> | undefined
    try {
      await untilSignalled(locked.promise, applying, 'the Apply holds the configuration lock')
      admitting = scheduler(project.researcherAccountId).runSingle(input)
      await untilLockWait(admitting, '%"modelConfiguration"%FOR SHARE%')
      assert.equal(await extractionRow(input.extractionId), null)
      release.resolve()
      await applying
      await assert.rejects(admitting, rejectsWithCode('method_changed'))
    } finally {
      // A failed assertion must not leave the Apply holding the row: released, it commits and the admission settles.
      release.resolve()
      await applying.catch(() => {})
      await admitting?.catch(() => {})
    }
    assert.equal(await extractionRow(input.extractionId), null)
  })

  it('an Apply waits for an admission that holds the configuration lock, and the run keeps what it saw', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    kei.holding = true
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: SPANS } })
    const locked = Promise.withResolvers<number>()
    const release = Promise.withResolvers<void>()
    // The enqueue follows the comparison in the admission's transaction, which then holds the configuration row's lock.
    const barrier: ExtractionExecution = {
      ...execution,
      async enqueue(client, workflow, input) {
        locked.resolve((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
        await release.promise
        await execution.enqueue(client, workflow, input)
      },
    }
    const module = createExtractionModule(
      createResearcherExtractionPersistence(project.researcherAccountId, barrier, { database: db as Database, packages }))
    const input = freshInput(project, randomUUID(), intent(SPANS))
    const admitting = module.runSingle(input)
    let applying: Promise<void> | undefined
    try {
      const admission = await untilSignalled(locked.promise, admitting, 'the admission holds the configuration lock')
      let applied = false
      applying = configureAccount(project.researcherAccountId, { extractionSettings: { article: QUOTES } })
        .then(() => { applied = true })
      await untilLockWait(applying, '%"modelConfiguration"%', admission)
      assert.equal(applied, false)
      release.resolve()
      assert.equal((await admitting).disposition, 'created')
      await applying
    } finally {
      // A failed assertion must not leave the admission holding the row: released, it commits and the Apply follows.
      release.resolve()
      await admitting.catch(() => {})
      await applying?.catch(() => {})
    }
    assert.deepEqual((await extractionRow(input.extractionId))?.requestedSettings, { article: SPANS })
    assert.deepEqual((await modelConfigurations.read(project.researcherAccountId) as { extractionSettings: unknown })
      .extractionSettings, { article: QUOTES })
    await heldByKei(input.extractionId)
  })

  it('kei receives the admitted method byte for value: strategy, models and every active option', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    kei.holding = true
    const models = { fields: 'instruct', reasoning: 'instruct' }
    await configureAccount(project.researcherAccountId, { extractionModels: models, extractionSettings: { article: SPANS } })
    const input = freshInput(project, randomUUID(), intent(SPANS, models))
    await scheduler(project.researcherAccountId).runSingle(input)
    await heldByKei(input.extractionId)
    const submitted = kei.submissions.find((submission) => submission.workflowId === keiExtractWorkflowId(input.extractionId))!
    assert.deepEqual((submitted.request as KeiExtractInput).request.options, { strategy: 'article', models, article: SPANS })
  })
})
