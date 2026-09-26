import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk'
import { validateDisposableTestDatabaseTarget } from './database-url.js'
import { withBlockedUpdates } from './postgres-test-helpers.js'
import type { TransactionalEnqueue } from './pool-client-transaction.js'

/**
 * A Batch Schema Suggestion attempt is a row and a `suggestSchemaBatch` workflow admitted in one transaction, and its
 * terminal writes are conditional on the row: only PostgreSQL and DBOS can prove either. DBOS is launched with no
 * workflows and no `suggest` queue, only to migrate a throwaway system schema, so every admitted attempt stays ENQUEUED
 * (active) until the check settles it through the worker store or cancels its workflow (interrupted). The check makes
 * its own account, so it needs no empty database, and deletes it and drops the schema when it ends.
 */
const databaseUrl = process.env.PROJECT_STORE_POSTGRES_URL

test('Batch Schema Suggestion attempts on PostgreSQL and DBOS', { timeout: 120_000 }, async (t) => {
  if (!databaseUrl)
    throw new Error(
      'Set PROJECT_STORE_POSTGRES_URL to a disposable free_test_* database, for example: pnpm --filter db db:start && createdb free_test_batch_suggestion.',
    )
  validateDisposableTestDatabaseTarget(databaseUrl)
  process.env.DATABASE_URL = databaseUrl

  const [{ db, pool }, store, { createCanonicalPackageStore, packCanonicalPackage }] = await Promise.all([
    import('./prisma/db.js'),
    import('./project-store.js'),
    import('./artifact-store.js'),
  ])
  const {
    createInternalProjectWorkerStore,
    createResearcherProjectStore,
    SUGGEST_QUEUE_NAME,
    SUGGEST_SCHEMA_BATCH_NAME,
  } = store

  const hex = randomBytes(4).toString('hex')
  const schema = `dbos_check_${hex}`
  const packageRoot = await mkdtemp(join(tmpdir(), 'free-batch-suggestion-check-'))
  const packages = createCanonicalPackageStore(packageRoot)
  const accountId = randomUUID()
  let admission: DBOSClient | undefined
  after(async () => {
    try {
      await admission?.destroy()
      await DBOS.shutdown()
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await db.orm.public.ProjectContext.where({ researcherAccountId: accountId }).delete()
      await db.orm.public.ResearcherAccount.where({ id: accountId }).delete()
    } finally {
      await db.close()
      await pool.end()
      await rm(packageRoot, { recursive: true, force: true })
    }
  })

  DBOS.setConfig({
    name: 'free-db-check',
    systemDatabaseUrl: databaseUrl,
    systemDatabaseSchemaName: schema,
    applicationVersion: 'check@1',
    executorID: `db-check-${hex}`,
    enableOTLP: false,
    logLevel: 'error',
  })
  await DBOS.launch()
  const client = await DBOSClient.create({
    systemDatabaseUrl: databaseUrl,
    systemDatabaseSchemaName: schema,
    applicationName: 'studio',
  })
  admission = client
  const enqueue: TransactionalEnqueue = async (pgClient, workflow, input) => {
    await client.enqueueInTransaction(pgClient, { ...workflow, attributes: { ...workflow.attributes } }, input)
  }
  const workflowStatuses = async (workflowIds: readonly string[]) =>
    new Map(
      (await client.listWorkflows({ workflowIDs: [...workflowIds], loadInput: false, loadOutput: false }))
        .map((workflow) => [workflow.workflowID, workflow.status] as const),
    )
  const researcher = createResearcherProjectStore(accountId, db, { workflowStatuses, enqueue })
  const worker = createInternalProjectWorkerStore(db, { packages })
  const attempts = async (id: string) =>
    (await client.listWorkflows({ workflow_id_prefix: `suggest:${id}:`, loadInput: false, loadOutput: false }))
      .map((workflow) => workflow.workflowID)
      .sort()
  const row = (id: string) =>
    db.orm.public.BatchSchemaSuggestion.select(
      'attempt', 'outcome', 'failure', 'phase', 'proposal', 'coverage', 'draft', 'draftVersion',
    ).first({ id })

  await db.orm.public.ResearcherAccount.create({
    id: accountId,
    tenantId: randomUUID(),
    objectId: randomUUID(),
    displayName: 'Suggestion check',
  })
  const project = await researcher.createProjectContext('Suggestion check')
  const projectContextId = project.projectContextId
  /** One Source Document with one revision whose package's Markdown is `markdown`. */
  async function source(markdown: string) {
    const pdf = new TextEncoder().encode(`%PDF-1.7\n% ${randomUUID()}\n`)
    const sha = createHash('sha256').update(pdf).digest('hex')
    const preprocessId = `check-${randomUUID()}`
    const saved = await packages.save(packCanonicalPackage({
      pdf,
      document: {
        schema_version: 'parsed_document.v2',
        document: { content_sha256: sha },
        preprocessing: { preprocess_id: preprocessId },
      },
      markdown,
    }))
    const document = await db.orm.public.SourceDocument.create({
      projectContextId,
      contentSha256: sha,
      mediaType: 'application/pdf',
      originalName: `${markdown}.pdf`,
    })
    const revision = await db.orm.public.SourceRepresentationRevision.create({
      sourceDocumentId: document.id,
      revisionNumber: 1,
      artifactReference: saved.artifactReference,
      artifactSha256: saved.artifactSha256,
      contractVersion: 'parsed_document.v2',
      preprocessId,
      parserName: 'check',
      parserVersion: '1',
    })
    return { sourceDocumentId: document.id, sourceRepresentationRevisionId: revision.id }
  }
  const sources = [await source('# Alpha'), await source('# Beta'), await source('# Gamma')]
  const pins = [...sources].sort((left, right) => left.sourceDocumentId.localeCompare(right.sourceDocumentId))
  const definition = (name: string) => ({
    recordDescription: `One ${name}.`,
    schemaNodes: [{ id: name, name, type: 'string' }],
  })
  const ready = (name: string) => ({
    phase: 'READY' as const,
    proposal: definition(name),
    coverage: [{ nodeId: name, present: 2, total: 2 }],
    draft: definition(name),
  })
  const failure = { code: 'source_suggestion_failed', message: 'Fields could not be suggested.' }

  let suggestionId = ''

  await t.test('creation commits the suggestion, its sorted pins and attempt 1\'s workflow together', async () => {
    const created = await researcher.createBatchSchemaSuggestion(
      projectContextId,
      [sources[1]!.sourceDocumentId, sources[0]!.sourceDocumentId],
    )
    assert.equal(created?.status, 'created')
    assert.ok(created && 'suggestion' in created)
    const suggestion = created.suggestion
    suggestionId = suggestion.batchSchemaSuggestionId
    const members = pins.filter((pin) => pin.sourceDocumentId !== sources[2]!.sourceDocumentId)
    assert.equal(suggestion.attempt, 1)
    assert.equal(suggestion.executionStatus, 'QUEUED')
    assert.equal(suggestion.phase, null)
    assert.deepEqual(
      suggestion.sources.map(({ sourceDocumentId, sourceRepresentationRevisionId }) => ({ sourceDocumentId, sourceRepresentationRevisionId })),
      members,
    )
    const workflow = await client.getWorkflow(`suggest:${suggestionId}:1`)
    assert.ok(workflow)
    assert.equal(workflow.status, 'ENQUEUED')
    assert.equal(workflow.workflowName, SUGGEST_SCHEMA_BATCH_NAME)
    assert.equal(workflow.queueName, SUGGEST_QUEUE_NAME)
    assert.equal(workflow.authenticatedUser, accountId)
    assert.deepEqual(workflow.attributes, { projectContextId, batchSchemaSuggestionId: suggestionId })
    const [listed] = await client.listWorkflows({ workflowIDs: [`suggest:${suggestionId}:1`], loadInput: true })
    assert.deepEqual(listed?.input, [{ batchSchemaSuggestionId: suggestionId, attempt: 1, projectContextId, members }])

    // An enqueue that fails after writing its workflow rolls the whole admission back.
    let attempted = ''
    const failing = createResearcherProjectStore(accountId, db, {
      workflowStatuses,
      async enqueue(pgClient, admitted, input) {
        attempted = admitted.workflowID
        await enqueue(pgClient, admitted, input)
        throw new Error('the enqueue failed after writing')
      },
    })
    await assert.rejects(
      failing.createBatchSchemaSuggestion(projectContextId, [sources[2]!.sourceDocumentId]),
      /the enqueue failed after writing/,
    )
    const [, rolledBack] = /^suggest:([0-9a-f-]+):1$/.exec(attempted) ?? []
    assert.ok(rolledBack)
    assert.equal(await db.orm.public.BatchSchemaSuggestion.select('id').first({ id: rolledBack }), null)
    assert.deepEqual(await db.orm.public.BatchSchemaSuggestionSource.where({ batchSchemaSuggestionId: rolledBack }).select('sourceDocumentId').all(), [])
    assert.equal(await client.getWorkflow(attempted), undefined)
  })

  await t.test('a repeated creation of the same selection replays the suggestion and enqueues nothing', async () => {
    const replayed = await researcher.createBatchSchemaSuggestion(
      projectContextId,
      [sources[0]!.sourceDocumentId, sources[1]!.sourceDocumentId],
    )
    assert.equal(replayed?.status, 'replayed')
    assert.ok(replayed && 'suggestion' in replayed)
    assert.equal(replayed.suggestion.batchSchemaSuggestionId, suggestionId)
    assert.equal(replayed.suggestion.executionStatus, 'QUEUED')
    assert.deepEqual(await attempts(suggestionId), [`suggest:${suggestionId}:1`])
  })

  await t.test('retry advances the attempt once; a repeat with the same expected attempt returns that successor even after it finished; an older expected attempt conflicts', async () => {
    assert.equal(await worker.failBatchSchemaSuggestionAttempt(suggestionId, 1, failure), 'published')
    const settled = await researcher.getBatchSchemaSuggestion(projectContextId, suggestionId)
    assert.equal(settled?.executionStatus, 'FAILED')
    assert.deepEqual(settled?.failure, failure)

    const retried = await researcher.retryBatchSchemaSuggestion(projectContextId, suggestionId, 1)
    assert.equal(retried?.status, 'retried')
    assert.ok(retried && 'suggestion' in retried)
    assert.equal(retried.suggestion.attempt, 2)
    assert.equal(retried.suggestion.executionStatus, 'QUEUED')
    assert.equal(retried.suggestion.failure, null)
    assert.deepEqual(await attempts(suggestionId), [`suggest:${suggestionId}:1`, `suggest:${suggestionId}:2`])
    const members = retried.suggestion.sources.map(({ sourceDocumentId, sourceRepresentationRevisionId }) => ({ sourceDocumentId, sourceRepresentationRevisionId }))
    const [second] = await client.listWorkflows({ workflowIDs: [`suggest:${suggestionId}:2`], loadInput: true })
    assert.deepEqual(second?.input, [{ batchSchemaSuggestionId: suggestionId, attempt: 2, projectContextId, members }])
    assert.equal(second?.queueName, SUGGEST_QUEUE_NAME)

    const repeated = await researcher.retryBatchSchemaSuggestion(projectContextId, suggestionId, 1)
    assert.equal(repeated?.status, 'replayed')
    assert.ok(repeated && 'suggestion' in repeated)
    assert.equal(repeated.suggestion.attempt, 2)
    assert.deepEqual(await attempts(suggestionId), [`suggest:${suggestionId}:1`, `suggest:${suggestionId}:2`])

    assert.equal(await worker.publishBatchSchemaSuggestion(suggestionId, 2, ready('place')), 'published')
    const afterFinish = await researcher.retryBatchSchemaSuggestion(projectContextId, suggestionId, 1)
    assert.equal(afterFinish?.status, 'replayed')
    assert.ok(afterFinish && 'suggestion' in afterFinish)
    assert.equal(afterFinish.suggestion.attempt, 2)
    assert.equal(afterFinish.suggestion.executionStatus, 'COMPLETED')
    assert.equal((await row(suggestionId))?.outcome, 'SUCCEEDED')
    assert.deepEqual(await attempts(suggestionId), [`suggest:${suggestionId}:1`, `suggest:${suggestionId}:2`])

    assert.deepEqual(await researcher.retryBatchSchemaSuggestion(projectContextId, suggestionId, 0), { status: 'attempt-conflict' })
    assert.equal(await researcher.retryBatchSchemaSuggestion(randomUUID(), suggestionId, 2), null)
  })

  await t.test('publication and failure write only the current attempt while it has no outcome', async () => {
    const before = await row(suggestionId)
    assert.equal(before?.draftVersion, 1)
    assert.deepEqual(before?.draft, definition('place'))
    // Attempt 2 has its outcome: neither a stale attempt nor a second publication of it writes anything.
    assert.equal(await worker.suggestionAttemptState(suggestionId, 2), 'stopped')
    assert.equal(await worker.publishBatchSchemaSuggestion(suggestionId, 2, ready('year')), 'stopped')
    assert.equal(await worker.failBatchSchemaSuggestionAttempt(suggestionId, 2, failure), 'stopped')
    assert.deepEqual(await row(suggestionId), before)

    assert.equal((await researcher.retryBatchSchemaSuggestion(projectContextId, suggestionId, 2))?.status, 'retried')
    assert.equal(await worker.suggestionAttemptState(suggestionId, 3), 'current')
    assert.equal(await worker.suggestionAttemptState(suggestionId, 2), 'stopped')
    assert.equal(await worker.publishBatchSchemaSuggestion(suggestionId, 1, ready('year')), 'stopped')
    assert.equal(await worker.failBatchSchemaSuggestionAttempt(suggestionId, 2, failure), 'stopped')
    // The retained proposal and draft stay while attempt 3 runs.
    assert.deepEqual((await row(suggestionId))?.draft, definition('place'))

    assert.equal(await worker.publishBatchSchemaSuggestion(suggestionId, 3, ready('year')), 'published')
    const published = await row(suggestionId)
    assert.equal(published?.outcome, 'SUCCEEDED')
    assert.equal(published?.draftVersion, 2)
    assert.deepEqual(published?.proposal, definition('year'))
    assert.deepEqual(published?.draft, definition('year'))
    assert.equal(await worker.publishBatchSchemaSuggestion(suggestionId, 3, ready('other')), 'stopped')
    assert.equal((await row(suggestionId))?.draftVersion, 2)

    assert.equal((await researcher.retryBatchSchemaSuggestion(projectContextId, suggestionId, 3))?.status, 'retried')
    assert.equal(await worker.failBatchSchemaSuggestionAttempt(suggestionId, 4, failure), 'published')
    assert.equal(await worker.failBatchSchemaSuggestionAttempt(suggestionId, 4, { code: 'other', message: 'Other.' }), 'stopped')
    const failed = await row(suggestionId)
    assert.equal(failed?.outcome, 'FAILED')
    assert.deepEqual(failed?.failure, failure)
    // A failed attempt keeps the proposal, draft and draft version it found.
    assert.equal(failed?.phase, 'READY')
    assert.deepEqual(failed?.proposal, definition('year'))
    assert.deepEqual(failed?.draft, definition('year'))
    assert.equal(failed?.draftVersion, 2)

    // A heterogeneous result clears the proposal and draft and still counts as a new version.
    assert.equal((await researcher.retryBatchSchemaSuggestion(projectContextId, suggestionId, 4))?.status, 'retried')
    assert.equal(await worker.publishBatchSchemaSuggestion(suggestionId, 5, { phase: 'HETEROGENEOUS' }), 'published')
    const heterogeneous = await row(suggestionId)
    assert.equal(heterogeneous?.phase, 'HETEROGENEOUS')
    assert.equal(heterogeneous?.draft, null)
    assert.equal(heterogeneous?.draftVersion, 3)
  })

  await t.test('a draft cannot be edited while an attempt is active', async () => {
    assert.equal((await researcher.retryBatchSchemaSuggestion(projectContextId, suggestionId, 5))?.status, 'retried')
    assert.equal(await worker.publishBatchSchemaSuggestion(suggestionId, 6, ready('place')), 'published')
    const version = (await row(suggestionId))!.draftVersion
    assert.equal((await researcher.retryBatchSchemaSuggestion(projectContextId, suggestionId, 6))?.status, 'retried')
    const edited = definition('edited')
    assert.deepEqual(
      await researcher.updateBatchSchemaSuggestionDraft(projectContextId, suggestionId, version, edited),
      { status: 'invalid' },
    )
    assert.deepEqual((await row(suggestionId))?.draft, definition('place'))
    assert.equal(await worker.failBatchSchemaSuggestionAttempt(suggestionId, 7, failure), 'published')
    const updated = await researcher.updateBatchSchemaSuggestionDraft(projectContextId, suggestionId, version, edited)
    assert.equal(updated?.status, 'updated')
    assert.ok(updated && 'suggestion' in updated)
    assert.deepEqual(updated.suggestion.draft, edited)
    assert.equal(updated.suggestion.draftVersion, version + 1)
  })

  await t.test('retry is refused while an attempt is active, after confirmation, and with no surviving member', async () => {
    assert.equal((await researcher.retryBatchSchemaSuggestion(projectContextId, suggestionId, 7))?.status, 'retried')
    assert.deepEqual(await researcher.retryBatchSchemaSuggestion(projectContextId, suggestionId, 8), { status: 'not-ready' })
    assert.deepEqual(await attempts(suggestionId), [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `suggest:${suggestionId}:${n}`))

    // An attempt without an outcome whose workflow was cancelled is interrupted: terminal, and retried like one.
    await client.cancelWorkflow(`suggest:${suggestionId}:8`)
    const interrupted = await researcher.getBatchSchemaSuggestion(projectContextId, suggestionId)
    assert.equal(interrupted?.executionStatus, 'FAILED')
    assert.equal((interrupted?.failure as { code?: string } | null)?.code, 'interrupted')
    assert.equal((await row(suggestionId))?.outcome, null)
    assert.equal((await researcher.retryBatchSchemaSuggestion(projectContextId, suggestionId, 8))?.status, 'retried')

    assert.equal(await worker.publishBatchSchemaSuggestion(suggestionId, 9, ready('place')), 'published')
    await db.orm.public.BatchSchemaSuggestion.where({ id: suggestionId }).update({ confirmedSchemaRevisionId: randomUUID() })
    assert.deepEqual(await researcher.retryBatchSchemaSuggestion(projectContextId, suggestionId, 9), { status: 'not-ready' })

    // Deleting a member's Source Document deletes only its pin; with none left, retry is refused and the draft stays.
    const single = await researcher.createBatchSchemaSuggestion(projectContextId, [sources[2]!.sourceDocumentId])
    assert.ok(single && 'suggestion' in single)
    const singleId = single.suggestion.batchSchemaSuggestionId
    assert.equal(await worker.publishBatchSchemaSuggestion(singleId, 1, ready('gamma')), 'published')
    assert.deepEqual(await researcher.deleteSourceDocument(projectContextId, sources[2]!.sourceDocumentId), { interruptedAttempts: [] })
    const orphaned = await researcher.getBatchSchemaSuggestion(projectContextId, singleId)
    assert.deepEqual(orphaned?.sources, [])
    assert.deepEqual(orphaned?.draft, definition('gamma'))
    assert.deepEqual(await researcher.retryBatchSchemaSuggestion(projectContextId, singleId, 1), { status: 'not-ready' })
    assert.deepEqual(await attempts(singleId), [`suggest:${singleId}:1`])
  })

  await t.test('the worker reads a pinned revision\'s Markdown, and nothing once the revision is gone', async () => {
    assert.equal(await worker.readRevisionMarkdown(sources[0]!.sourceRepresentationRevisionId), '# Alpha')
    assert.equal(await worker.readRevisionMarkdown(sources[2]!.sourceRepresentationRevisionId), null)
    assert.equal(await worker.projectContextOwner(projectContextId), accountId)
  })

  await t.test('two retries of the same expected attempt admit one successor', async () => {
    const created = await researcher.createBatchSchemaSuggestion(projectContextId, [sources[0]!.sourceDocumentId])
    assert.ok(created && 'suggestion' in created)
    const id = created.suggestion.batchSchemaSuggestionId
    assert.equal(await worker.failBatchSchemaSuggestionAttempt(id, 1, failure), 'published')
    const results = await withBlockedUpdates(databaseUrl, 'BatchSchemaSuggestion', id, 2,
      () => Promise.all([1, 2].map(() => researcher.retryBatchSchemaSuggestion(projectContextId, id, 1))),
    )
    assert.deepEqual(results.map((result) => result?.status).sort(), ['replayed', 'retried'])
    assert.deepEqual(await attempts(id), [`suggest:${id}:1`, `suggest:${id}:2`])
  })

  await t.test('the membership table holds pins only', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'batchSchemaSuggestionSource' ORDER BY column_name`,
    )
    assert.deepEqual(rows.map((column) => column.column_name), [
      'batchSchemaSuggestionId',
      'sourceDocumentId',
      'sourceRepresentationRevisionId',
    ])
  })
})
