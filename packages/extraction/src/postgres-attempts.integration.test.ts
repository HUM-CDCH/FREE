import { DBOS } from '@dbos-inc/dbos-sdk'
import type { Database } from 'db'
import { withBlockedUpdates } from 'db/postgres-test-helpers'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import pg from 'pg'
import type { ExtractionExecution } from './dependencies.js'
import { keiExpGroundedArtifact } from './kei-exp-fixture.js'
import { keiExtractWorkflowId, type KeiExtractInput } from './kei-handoff.js'
import { createExtractionModule } from './module.js'
import { fixture, type SeededDocument } from './testing/extraction-fixture.js'
import { RUN_EXTRACTION } from './workflows.js'

describe('Extraction attempts on disposable PostgreSQL', { skip: !fixture && 'set EXTRACTION_TEST_DATABASE_URL (or DATABASE_URL) to a migrated disposable free_test_* database' }, () => {
  if (!fixture) return
  const {
    disposableDatabaseUrl, ARTICLE_SCHEMA, db, stableJson, stableUuid,
    createResearcherProjectStore, createResearcherExtractionPersistence, createExtractionStore, settleExtraction, packages,
    kei, app, execution, executionCancels, deterministicArtifact,
    seedProject, withRecordScope, scheduler, eventually, createRuntime, freshInput,
    rejectsWithCode, waitForBatch, studioWorkflow, heldByKei, extractionRow,
    succeeded, cleanup,
  } = fixture

  it('derives QUEUED, RUNNING and interrupted from DBOS and never reports a settled row as running', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const document = project.documents[0]!
    const module = scheduler(project.researcherAccountId)
    // A workflow DBOS holds back (DELAYED) reads as QUEUED.
    const delayed = randomUUID()
    await db.orm.public.Extraction.create({
      id: delayed, sourceDocumentId: document.sourceDocumentId,
      sourceRepresentationRevisionId: document.sourceRepresentationRevisionId, schemaRevisionId: project.schemaRevisionId,
      strategy: 'ARTICLE', catalogRecipe: null, requestedModels: null, batchExtractionId: null,
    })
    await app.admission.enqueue(
      { workflowName: RUN_EXTRACTION, workflowID: `extract:${delayed}`, queueName: 'studio', delaySeconds: 3_600 },
      delayed,
    )
    assert.equal((await module.readExtractionAttempt(delayed))?.executionStatus, 'QUEUED')
    // Its workflow cancelled without an outcome: interrupted.
    await DBOS.cancelWorkflow(`extract:${delayed}`)
    const interrupted = await module.readExtractionAttempt(delayed)
    assert.equal(interrupted?.executionStatus, 'FAILED')
    assert.equal(interrupted?.outcome, null)
    assert.deepEqual(interrupted?.failure, {
      code: 'interrupted', message: 'This work stopped before it finished. Start it again.', phase: 'extracting',
    })
    // A held kei keeps the workflow PENDING: RUNNING.
    kei.holding = true
    const input = freshInput(project)
    await module.runSingle(input)
    await heldByKei(input.extractionId)
    assert.equal((await studioWorkflow(input.extractionId))?.status, 'PENDING')
    const running = await module.readExtractionAttempt(input.extractionId)
    assert.equal(running?.executionStatus, 'RUNNING')
    assert.equal(running?.result, null)
    // An outcome on the row wins while its workflow is still PENDING.
    assert.equal(await settleExtraction(db.orm, input.extractionId, {
      outcome: 'FAILED', failure: { code: 'extraction_failed', message: 'Settled first.', phase: 'extracting' },
    }), 'settled')
    assert.equal((await studioWorkflow(input.extractionId))?.status, 'PENDING')
    const settled = await module.readExtractionAttempt(input.extractionId)
    assert.equal(settled?.executionStatus, 'FAILED')
    assert.equal(settled?.failure?.message, 'Settled first.')
    // The workflow finishes later and writes nothing over it.
    kei.release(input.extractionId)
    await eventually(() => studioWorkflow(input.extractionId), (workflow) => workflow?.status === 'SUCCESS', 'runExtraction ends')
    assert.equal((await extractionRow(input.extractionId))?.outcome, 'FAILED')
  })

it('a legacy sample row is never the latest or the latest reviewed attempt', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const document = project.documents[0]!
    const { module } = createRuntime(project.researcherAccountId)
    const full = await module.runSingle(freshInput(project))
    await module.finalizeReview(full.extraction.extractionId, (await module.prepareReview(full.extraction.extractionId)).reviewDecisions)
    // A row the removed sample workbench wrote: newer than the whole-document run, scoped to one page, reviewed.
    const later = new Date(Date.now() + 60_000)
    const legacyId = randomUUID()
    await db.orm.public.Extraction.create({
      id: legacyId, sourceDocumentId: document.sourceDocumentId,
      sourceRepresentationRevisionId: document.sourceRepresentationRevisionId, schemaRevisionId: project.schemaRevisionId,
      strategy: 'ARTICLE', catalogRecipe: null, requestedModels: null, batchExtractionId: null,
      requestedPages: [1], outcome: 'SUCCEEDED', reviewedAt: later, createdAt: later,
    })
    const reopened = await module.readDocumentExtractions({ sourceDocumentId: document.sourceDocumentId })
    assert.equal(reopened?.latestAttempt?.extractionId, full.extraction.extractionId)
    assert.equal(reopened?.latestReviewed?.extractionId, full.extraction.extractionId)
    assert.equal('samples' in (reopened ?? {}), false)
    // Nor is it a document's result when named, a project summary's Extraction, or a recent activity.
    assert.equal(await module.readDocumentExtractions({ sourceDocumentId: document.sourceDocumentId, extractionId: legacyId }), null)
    const listed = await createResearcherProjectStore(project.researcherAccountId, db, { workflowStatuses: execution.statuses })
      .listProjectContexts(20)
    assert.equal(listed.find((item) => item.projectContextId === project.projectContextId)?.summary.extractionCount, 1)
    const activity = await createResearcherProjectStore(project.researcherAccountId, db).listRecentActivity(20)
    assert.equal(activity.filter((event) => event.kind === 'extraction_appended').length, 1)
  })

it('a SUCCESS workflow over a row without an outcome reads as interrupted after the re-read', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const { module } = createRuntime(project.researcherAccountId)
    const completed = await module.runSingle(freshInput(project))
    const id = completed.extraction.extractionId
    await eventually(() => studioWorkflow(id), (workflow) => workflow?.status === 'SUCCESS', 'runExtraction ends')
    // A workflow that returned SUCCESS without publishing (here: an outcome removed behind its back).
    await db.orm.public.Extraction.where({ id }).updateAll({ outcome: null })
    const read = await module.readExtractionAttempt(id)
    assert.equal(read?.executionStatus, 'FAILED')
    assert.equal(read?.failure?.code, 'interrupted')
  })

it('cancel racing completion has one winner', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const module = scheduler(project.researcherAccountId)
    const store = createExtractionStore({ database: db as Database, packages })
    const probe = new pg.Client({ connectionString: disposableDatabaseUrl })
    await probe.connect()
    t.after(() => probe.end())
    /** Waits until `count` backends wait on the Extraction row lock with their conditional UPDATE. */
    const blockedWriters = (count: number) => eventually(async () => {
      await probe.query('SELECT pg_stat_clear_snapshot()')
      const { rows } = await probe.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()
           AND wait_event_type = 'Lock' AND query ILIKE '%UPDATE%"extraction"%'`)
      return rows[0]!.count
    }, (blocked) => blocked >= count, `${count} blocked Extraction writes`)
    kei.holding = true
    const winners: string[] = []
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const input = freshInput(project)
      await module.runSingle(input)
      await heldByKei(input.extractionId)
      const cancel = () => module.cancelSingle(input.extractionId)
      const complete = () =>
        store.settle(input.extractionId, { outcome: 'SUCCEEDED', extraction: succeeded(input.extractionId, project) })
      // A second connection holds the row, so both conditional UPDATEs queue on its lock and really collide; the
      // writer that queued first (alternating) takes the lock first, and the other re-checks `outcome IS NULL`.
      const collide = async (): Promise<[string, string]> => {
        if (iteration % 2 === 0) {
          const first = cancel()
          await blockedWriters(1)
          return Promise.all([first, complete()])
        }
        const first = complete()
        await blockedWriters(1)
        return Promise.all([cancel(), first])
      }
      const written: [string, string] =
        await withBlockedUpdates(disposableDatabaseUrl, 'Extraction', input.extractionId, 2, collide)
      const [cancelled, completed] = written
      const cancelWon: boolean = cancelled === 'cancellation-requested'
      assert.equal(cancelWon, completed === 'already-settled', `iteration ${iteration}: exactly one wrote`)
      assert.equal(completed === 'settled' || completed === 'already-settled', true)
      winners.push(cancelWon ? 'cancel' : 'completion')
      const row = await extractionRow(input.extractionId)
      assert.equal(row?.outcome, cancelWon ? 'CANCELLED' : 'SUCCEEDED')
      // No second write: a later attempt at either finds the outcome.
      assert.equal(await complete(), 'already-settled')
      assert.equal(await cancel(), 'not-found')
    }
    // Both branches ran: a cancel that won and a completion that won.
    assert.ok(winners.includes('cancel'), winners.join(','))
    assert.ok(winners.includes('completion'), winners.join(','))
  })

it('a status read racing a cancel shows the cancellation, not an interruption', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const cancelling = scheduler(project.researcherAccountId)
    kei.holding = true
    const input = freshInput(project)
    await cancelling.runSingle(input)
    await heldByKei(input.extractionId)
    // The read loads the row (no outcome yet); the cancel commits and stops the workflow before the read asks DBOS.
    let raced = false
    const racing: ExtractionExecution = {
      ...execution,
      async statuses(workflowIds) {
        if (!raced) {
          raced = true
          assert.equal(await cancelling.cancelSingle(input.extractionId), 'cancellation-requested')
          assert.equal((await studioWorkflow(input.extractionId))?.status, 'CANCELLED')
        }
        return execution.statuses(workflowIds)
      },
    }
    const reader = createExtractionModule(
      createResearcherExtractionPersistence(project.researcherAccountId, racing, { database: db as Database, packages }),
    )
    const read = await reader.readExtractionAttempt(input.extractionId)
    assert.ok(raced)
    assert.equal(read?.executionStatus, 'FAILED')
    assert.deepEqual(read?.failure, { code: 'cancelled', message: 'Extraction cancelled.', phase: 'extracting' })
  })

it('a replay of a failed Extraction returns its failure, even after its workflow history was deleted, and enqueues nothing', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const { module } = createRuntime(project.researcherAccountId)
    kei.respond = () => ({ failure: { code: 'extraction_failed', reason: 'the model server refused the request', retryable: false } })
    const input = freshInput(project)
    const failed = await module.runSingle(input)
    assert.equal(failed.extraction.executionStatus, 'FAILED')
    assert.equal((await extractionRow(input.extractionId))?.outcome, 'FAILED')
    await DBOS.deleteWorkflows([`extract:${input.extractionId}`])
    const submitted = kei.submissions.length
    const replayed = await module.runSingle(input)
    assert.equal(replayed.disposition, 'replayed')
    assert.equal(replayed.extraction.executionStatus, 'FAILED')
    assert.deepEqual(replayed.extraction.failure, failed.extraction.failure)
    assert.deepEqual(await app.admission.listWorkflows({ workflowIDs: [`extract:${input.extractionId}`] }), [])
    assert.equal(kei.submissions.length, submitted)
  })

it('cancel writes the cancelled outcome and stops the Studio workflow and its kei child', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const module = scheduler(project.researcherAccountId)
    kei.holding = true
    const input = freshInput(project)
    await module.runSingle(input)
    await heldByKei(input.extractionId)
    assert.equal(await module.cancelSingle(input.extractionId), 'cancellation-requested')
    const row = await extractionRow(input.extractionId)
    assert.equal(row?.outcome, 'CANCELLED')
    assert.equal((row?.failure as { code?: string } | null)?.code, 'cancelled')
    assert.equal((await studioWorkflow(input.extractionId))?.status, 'CANCELLED')
    assert.deepEqual(executionCancels.filter((id) => id === input.extractionId), [input.extractionId])
    assert.ok(kei.cancels.includes(keiExtractWorkflowId(input.extractionId)))
    const read = await module.readExtractionAttempt(input.extractionId)
    assert.equal(read?.executionStatus, 'FAILED')
    assert.equal(read?.failure?.code, 'cancelled')
    assert.equal(await module.cancelSingle(input.extractionId), 'not-found')
    assert.equal(await module.cancelSingle(randomUUID()), 'not-found')
  })

it('an Extraction deleted while it runs publishes nothing and fails no surviving member', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['deleted.pdf', 'kept.pdf'])
    const [deleted, kept] = project.documents as [SeededDocument, SeededDocument]
    const module = scheduler(project.researcherAccountId)
    const store = createResearcherProjectStore(project.researcherAccountId, db)
    kei.holding = true
    const scheduled = await module.scheduleBatch({
      projectContextId: project.projectContextId,
      schemaRevisionId: project.schemaRevisionId,
      strategy: 'ARTICLE',
      sourceDocumentIds: [deleted.sourceDocumentId, kept.sourceDocumentId],
      repetition: 'create-new',
      method: { models: null, settings: { article: null } },
    })
    const batchExtractionId = scheduled.batch.batchExtractionId
    const memberOf = (document: SeededDocument) =>
      stableUuid('batch-member-extraction', stableJson([batchExtractionId, document.sourceDocumentId]))
    await heldByKei(memberOf(deleted))
    await heldByKei(memberOf(kept))
    assert.deepEqual(await store.deleteSourceDocument(project.projectContextId, deleted.sourceDocumentId), { interruptedAttempts: [] })
    assert.equal(await extractionRow(memberOf(deleted)), null)
    kei.releaseAll()
    await eventually(() => studioWorkflow(memberOf(deleted)), (workflow) => workflow?.status === 'SUCCESS',
      'the deleted member\'s workflow ends without an error')
    const batch = await waitForBatch(module, project.projectContextId, batchExtractionId,
      (candidate) => candidate.executionStatus === 'COMPLETED')
    assert.deepEqual(batch.members.map((member) => [member.sourceDocumentId, member.executionStatus]),
      [[kept.sourceDocumentId, 'COMPLETED']])
    assert.equal((await extractionRow(memberOf(kept)))?.outcome, 'SUCCEEDED')
    assert.equal(await createExtractionStore({ database: db as Database, packages }).settle(memberOf(deleted), {
      outcome: 'FAILED', failure: { code: 'extraction_failed', message: 'late', phase: 'extracting' },
    }), 'missing')
  })

it('runExtraction records keiRunId from the pinned revision', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const document = project.documents[0]!
    const { module } = createRuntime(project.researcherAccountId)
    const input = freshInput(project)
    await module.runSingle(input)
    const [workflow] = await app.admission.listWorkflows({ workflowIDs: [`extract:${input.extractionId}`] })
    assert.equal(workflow?.attributes?.keiRunId, document.runId)
    const submission = kei.submissions.find((candidate) => candidate.workflowId === keiExtractWorkflowId(input.extractionId))
    assert.equal(submission?.attributes.keiRunId, document.runId)
    assert.equal((submission?.request as KeiExtractInput).run_id, document.runId)
  })

it('persists and reopens a partial remote Catalog result without local stage diagnostics', async (t) => {
    t.after(cleanup)
    const project = await withRecordScope(await seedProject(), 'records')
    kei.respond = (request) => ({ artifact: { ...deterministicArtifact(request), complete: false } })
    const { module } = createRuntime(project.researcherAccountId)
    const input = { ...freshInput(project), strategy: 'CATALOG' as const, method: { models: null, settings: { generic: null } } }
    const created = await module.runSingle(input)
    assert.equal(created.extraction.complete, false)
    assert.equal(created.extraction.outcome, 'SUCCEEDED')
    assert.equal(created.extraction.diagnostics!.catalog, null)
    assert.equal((await module.runSingle(input)).disposition, 'replayed')
    assert.equal(kei.submissions.length, 1)
    const reopened = await module.readDocumentExtractions({ sourceDocumentId: project.documents[0]!.sourceDocumentId })
    assert.deepEqual(reopened?.latestAttempt?.result, created.extraction.result)
    const prepared = await module.prepareReview(input.extractionId)
    assert.equal((await module.finalizeReview(input.extractionId, prepared.reviewDecisions)).disposition, 'reviewed')
  })

it('persists and reopens a version 2 recipe result with its span evidence and review material', async (t) => {
    t.after(cleanup)
    const project = await withRecordScope(await seedProject(), 'records')
    kei.respond = (request) => ({
      artifact: keiExpGroundedArtifact({
        run_id: request.run_id, generation: request.generation, schema: request.request.schema as never, model: 'deterministic',
        records: [{ title: 'Alpha' }], record_blocks: [{ block: 'b1', entry_label: '1' }],
        evidence: [{ path: ['records', 0, 'title'], segment: 'p1_s0', page: 1, bbox_pt: [10, 10, 100, 30],
                     verbatim: true, hits: 1, linked_by: 'key', spans: [{ segment: 'p1_s0', start: 0, end: 5 }],
                     alternatives: [], provenance: 'token', key_spans: [], heading: null, precision: 'segment',
                     raw: 'Alpha', normalized: { value: 'Alphabet', rule: 'glossary',
                                                 key_span: { segment: 'p1_s0', start: 0, end: 5 },
                                                 expansion_span: { segment: 'p1_s0', start: 8, end: 16 } } }],
      }),
    })
    const { module } = createRuntime(project.researcherAccountId)
    const input = {
      ...freshInput(project), strategy: 'CATALOG' as const, catalogRecipe: 'numbered-catalogue-de@1',
      method: { models: null, settings: { recipe: null } },
    }
    const created = await module.runSingle(input)
    assert.deepEqual((kei.submissions[0]!.request as KeiExtractInput).request.options.catalog, { recipe: 'numbered-catalogue-de@1' })
    const reopened = await module.readDocumentExtractions({ sourceDocumentId: project.documents[0]!.sourceDocumentId })
    const attempt = reopened!.latestAttempt!
    assert.equal(attempt.extractionId, created.extraction.extractionId)
    assert.deepEqual(attempt.evidence![0]!.grounding, {
      linkedBy: 'key', provenance: 'token', textSpans: [{ segment: 'p1_s0', start: 0, end: 5 }], keySpans: [],
      alternatives: [], heading: null, precision: 'segment', raw: 'Alpha',
      normalized: { value: 'Alphabet', rule: 'glossary', keySpan: { segment: 'p1_s0', start: 0, end: 5 },
                    expansionSpan: { segment: 'p1_s0', start: 8, end: 16 } },
    })
    const grounded = attempt.diagnostics!.grounded!
    const fixture = keiExpGroundedArtifact()
    assert.equal(grounded.recipe, 'numbered-catalogue-de@1')
    assert.deepEqual(grounded.proposed, fixture.proposed)
    assert.deepEqual(grounded.rejected, fixture.rejected)
    assert.deepEqual(grounded.coverage, fixture.coverage)
    assert.deepEqual(grounded.completeness, fixture.completeness)
    const prepared = await module.prepareReview(input.extractionId)
    assert.equal(prepared.reviewDecisions.length, 1)
    assert.equal((await module.finalizeReview(input.extractionId, prepared.reviewDecisions)).disposition, 'reviewed')
  })

it('a failed Extraction keeps its failure on its row and publishes no result', async (t) => {
    t.after(cleanup)
    const article = await seedProject()
    kei.respond = () => ({ failure: { code: 'extraction_failed', reason: 'controlled extraction failure', retryable: false } })
    const failed = await createRuntime(article.researcherAccountId).module.runSingle(freshInput(article))
    assert.equal(failed.extraction.executionStatus, 'FAILED')
    assert.equal(failed.extraction.outcome, null)
    assert.equal(failed.extraction.complete, null)
    assert.equal(failed.extraction.result, null)
    assert.deepEqual(failed.extraction.failure, {
      code: 'extraction_failed', message: 'kei-exp could not complete the Extraction: controlled extraction failure', phase: 'extracting',
    })
    const row = await extractionRow(failed.extraction.extractionId)
    assert.equal(row?.outcome, 'FAILED')
    assert.equal(row?.resultPayload, null)
  })

it('fails an Extraction whose canonical package is unavailable without inventing a result', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const document = project.documents[0]!
    const { module } = createRuntime(project.researcherAccountId)
    await packages.remove(document.storedPackage, async () => false)
    const input = freshInput(project)

    const failed = await module.runSingle(input)
    assert.equal(failed.extraction.executionStatus, 'FAILED')
    assert.equal(failed.extraction.outcome, null)
    assert.deepEqual(failed.extraction.failure, {
      code: 'invalid_source_representation', message: 'The pinned Source Representation is unavailable.', phase: 'persisting',
    })
    const row = await extractionRow(input.extractionId)
    assert.equal(row?.outcome, 'FAILED')
    assert.equal(row?.resultPayload, null)
    assert.equal(await module.cancelSingle(input.extractionId), 'not-found')
  })

it('reads no result values from a row without a published result, whatever its columns hold', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const module = scheduler(project.researcherAccountId)
    kei.holding = true
    const input = freshInput(project)
    await module.runSingle(input)
    await heldByKei(input.extractionId)
    const planted = {
      complete: true,
      modelAttribution: { provider: 'kei-exp', modelId: 'planted' },
      diagnostics: { phase: 'grounding' },
      resultPayload: { records: [{ place: 'Rome' }] },
      evidenceLinks: [],
      reviewable: true,
    }
    await db.orm.public.Extraction.where({ id: input.extractionId }).updateAll(planted)
    const running = await module.readExtractionAttempt(input.extractionId)
    assert.equal(running?.executionStatus, 'RUNNING')
    assert.deepEqual([running?.result, running?.complete, running?.modelAttribution, running?.diagnostics, running?.reviewable],
      [null, null, null, null, false])
    const failure = { code: 'planted_failure', message: 'A planted failure.', phase: 'grounding' as const }
    await db.orm.public.Extraction.where({ id: input.extractionId }).updateAll({ outcome: 'FAILED', failure })
    const failed = await module.readExtractionAttempt(input.extractionId)
    assert.equal(failed?.executionStatus, 'FAILED')
    assert.deepEqual([failed?.result, failed?.complete, failed?.modelAttribution, failed?.diagnostics, failed?.reviewable],
      [null, null, null, null, false])
    assert.deepEqual(failed?.failure, failure)
    await assert.rejects(module.prepareReview(input.extractionId), rejectsWithCode('not_found'))
  })
  it('one stored method that no longer parses does not break reading the Extraction or listing its batch', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['a.pdf', 'b.pdf'])
    kei.holding = true
    const module = scheduler(project.researcherAccountId)
    const opened = await module.scheduleBatch({
      projectContextId: project.projectContextId, schemaRevisionId: project.schemaRevisionId, strategy: 'ARTICLE',
      sourceDocumentIds: project.documents.map((document) => document.sourceDocumentId), repetition: 'reuse-equal-selection',
      method: { models: null, settings: { article: null } },
    })
    const single = freshInput(project, randomUUID(), { models: null, settings: { article: null } })
    await module.runSingle(single)
    // A later narrowing of the method contract would leave rows like these behind.
    const retired = { article: { context: 'full', retired_factor: true } }
    await db.orm.public.Extraction.where({ id: single.extractionId }).update({ requestedSettings: retired })
    await db.orm.public.BatchExtraction.where({ id: opened.batch.batchExtractionId }).update({ requestedSettings: retired })
    const attempt = await module.readExtractionAttempt(single.extractionId)
    assert.ok(attempt, 'the Extraction is still readable')
    assert.equal(attempt.requestedSettings, null)
    const [listed] = await module.listBatches({ projectContextId: project.projectContextId })
    assert.equal(listed?.batchExtractionId, opened.batch.batchExtractionId)
    const read = await module.readBatch({ projectContextId: project.projectContextId, batchExtractionId: opened.batch.batchExtractionId })
    assert.equal(read.batchExtractionId, opened.batch.batchExtractionId)
  })
})
