import { DBOS } from '@dbos-inc/dbos-sdk'
import type { Database } from 'db'
import { strToU8 } from 'fflate'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import pg from 'pg'
import type { ExtractionExecution } from './dependencies.js'
import { ExtractionError } from './errors.js'
import { REFERENCE_ARTICLE, type ExtractionMethodIntent } from './extraction-method.js'
import { keiExtractWorkflowId, type KeiExtractInput } from './kei-handoff.js'
import { createExtractionModule } from './module.js'
import { saveStoredReviewDraft } from './postgres-reviews.js'
import { fixture, type SeededDocument, type SeededProject } from './testing/extraction-fixture.js'
import type { BatchRepetition } from './types.js'
import { RUN_EXTRACTION } from './workflows.js'

/** What a start view submits for an account that keeps every service default. */
const SERVICE_DEFAULTS: ExtractionMethodIntent = { models: null, settings: { article: null } }

describe('Extraction batches on disposable PostgreSQL', { skip: !fixture && 'set EXTRACTION_TEST_DATABASE_URL (or DATABASE_URL) to a migrated disposable free_test_* database' }, () => {
  if (!fixture) return
  const {
    sha256, disposableDatabaseUrl, ARTICLE_SCHEMA, db, stableJson,
    stableUuid, createResearcherProjectStore, createResearcherExtractionPersistence, packages, kei,
    app, execution, seedProject, addRepresentation, scheduler,
    eventually, createRuntime, freshInput, rejectsWithCode, waitForBatch,
    heldByKei, extractionRow, cleanup, configureAccount, modelConfigurations, untilLockWait, untilSignalled, ports,
    succeeded,
  } = fixture

  async function sample(project: SeededProject, document: SeededDocument, anchor: string) {
    const id = randomUUID(), path = ['records', 0, 'title']
    await db.orm.public.Extraction.create({ id, sourceDocumentId: document.sourceDocumentId,
      sourceRepresentationRevisionId: document.sourceRepresentationRevisionId, schemaRevisionId: project.schemaRevisionId,
      strategy: 'ARTICLE', requestedPages: [1], outcome: 'SUCCEEDED', complete: true, reviewable: true,
      diagnostics: succeeded(id, project).diagnostics, resultPayload: { records: [{ title: 'Alpha' }] },
      evidenceLinks: [{ resultPath: path, evidenceAnchorId: anchor }], reviewDraftVersion: 1,
      reviewDraft: [{ resultPath: path, evidenceAnchorId: anchor, reviewedOccurrenceIds: [], action: 'APPROVED', reviewedValue: null }] })
    return id
  }

  // Observe the real pooled transaction; fail a snapshot read before its row/enqueue can commit.
  async function observeSnapshots<T>(run: () => Promise<T>, failSource?: string) {
    const original = pg.Client.prototype.query
    const reads: string[] = [], counts = new Map<object, number>(), clients = new Set<object>()
    pg.Client.prototype.query = new Proxy(original, { apply(target, client: object, args: unknown[]) {
      counts.set(client, (counts.get(client) ?? 0) + 1)
      const query = args[0] as string | { text?: string; values?: unknown[] }
      const sql = typeof query === 'string' ? query : query.text ?? ''
      const values = (typeof query === 'string' ? args[1] : query.values) as unknown[] | undefined
      if (sql.includes('"requestedPages"') && sql.includes('"reviewDraftVersion"') && sql.includes('"reviewPairings"') && sql.startsWith('SELECT')) {
        const source = values?.find((value) => typeof value === 'string' && selectedSources.has(value)) as string | undefined
        assert.ok(source, 'snapshot reads must have one selected-source predicate')
        reads.push(source); clients.add(client)
        if (source === failSource) return Promise.reject(new Error('snapshot read failed on member4'))
      }
      return Reflect.apply(target, client, args)
    } })
    const started = performance.now()
    try {
      const result = await run()
      return { result, reads, queries: [...clients].reduce((sum, client) => sum + counts.get(client)!, 0), elapsedMs: performance.now() - started }
    } finally { pg.Client.prototype.query = original }
  }
  const selectedSources = new Set<string>()

  for (const size of [6, 50]) it(`pins only selected-source samples for ${size} members, retaining replay snapshots`, async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, Array.from({ length: size + 1 }, (_, index) => `${index}.pdf`))
    const selected = project.documents.slice(0, size)
    selectedSources.clear(); selected.forEach((document) => selectedSources.add(document.sourceDocumentId))
    kei.holding = true
    // Two eligible samples on one source, and unrelated history that must never be queried.
    const first = await sample(project, selected[0]!, 'a_p1_s0')
    await sample(project, selected[0]!, 'a_p2_s0')
    await sample(project, project.documents[size]!, 'outside-selection')
    const request = { projectContextId: project.projectContextId, schemaRevisionId: project.schemaRevisionId,
      sourceDocumentIds: selected.map((document) => document.sourceDocumentId), strategy: 'ARTICLE' as const,
      repetition: 'reuse-equal-selection' as const, method: SERVICE_DEFAULTS }
    const module = scheduler(project.researcherAccountId)
    const measured = await observeSnapshots(() => module.scheduleBatch(request))
    assert.equal(measured.reads.length, size)
    assert.deepEqual(new Set(measured.reads), selectedSources)
    const members = () => db.orm.public.Extraction.where({ batchExtractionId: measured.result.batch.batchExtractionId })
      .select('id', 'sourceDocumentId', 'requestedPages', 'reviewTransfer').all()
    const rows = await members(), pinned = rows.find((row) => row.sourceDocumentId === selected[0]!.sourceDocumentId)!.reviewTransfer
    assert.equal((pinned as { entries: unknown[] }).entries.length, 2)
    assert.equal(rows.filter((row) => row.reviewTransfer !== null).length, 1)
    assert.ok(rows.every((row) => row.requestedPages === null))
    t.diagnostic(JSON.stringify({ members: size, snapshotReads: measured.reads.length, queries: measured.queries,
      elapsedMs: Math.round(measured.elapsedMs), snapshotBytes: Buffer.byteLength(JSON.stringify(pinned)) }))
    await saveStoredReviewDraft(db as Database, project.researcherAccountId, first, { version: 1, decisions: [] })
    assert.equal((await module.scheduleBatch(request)).disposition, 'replayed')
    assert.deepEqual((await members()).find((row) => row.sourceDocumentId === selected[0]!.sourceDocumentId)!.reviewTransfer, pinned)
    const fresh = await module.scheduleBatch({ ...request, repetition: 'create-new' })
    const refreshed = await db.orm.public.Extraction.where({ batchExtractionId: fresh.batch.batchExtractionId,
      sourceDocumentId: selected[0]!.sourceDocumentId }).select('reviewTransfer').first()
    assert.equal((refreshed!.reviewTransfer as { entries: unknown[] }).entries.length, 1)
  })

  for (const suggested of [false, true]) it(`snapshot failure on member4 rolls back ${suggested ? 'suggested' : 'ordinary'} batch admission`, async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, Array.from({ length: 6 }, (_, index) => `${index}.pdf`))
    const selected = [...project.documents].sort((a, b) => a.sourceDocumentId.localeCompare(b.sourceDocumentId))
    selectedSources.clear(); selected.forEach((document) => selectedSources.add(document.sourceDocumentId))
    kei.holding = true
    const module = scheduler(project.researcherAccountId)
    const suggestionId = randomUUID()
    if (suggested) {
      await db.orm.public.BatchSchemaSuggestion.create({ id: suggestionId, projectContextId: project.projectContextId,
        selectionKey: sha256(strToU8(suggestionId)), outcome: 'SUCCEEDED', phase: 'READY', draft: ARTICLE_SCHEMA, draftVersion: 1 })
      for (const document of selected) await db.orm.public.BatchSchemaSuggestionSource.create({ batchSchemaSuggestionId: suggestionId,
        sourceDocumentId: document.sourceDocumentId, sourceRepresentationRevisionId: document.sourceRepresentationRevisionId })
    }
    const run = () => suggested ? module.scheduleSuggestedBatch({ projectContextId: project.projectContextId, batchSchemaSuggestionId: suggestionId,
      strategy: 'ARTICLE', method: SERVICE_DEFAULTS }) : module.scheduleBatch({ projectContextId: project.projectContextId,
      schemaRevisionId: project.schemaRevisionId, sourceDocumentIds: selected.map((document) => document.sourceDocumentId),
      strategy: 'ARTICLE', repetition: 'reuse-equal-selection', method: SERVICE_DEFAULTS })
    await assert.rejects(observeSnapshots(run, selected[3]!.sourceDocumentId), /snapshot read failed on member4/)
    assert.deepEqual(await db.orm.public.BatchExtraction.where({ projectContextId: project.projectContextId }).select('id').all(), [])
    for (const document of selected) assert.deepEqual(await db.orm.public.Extraction.where({ sourceDocumentId: document.sourceDocumentId }).select('id').all(), [])
    assert.deepEqual(await app.admission.listWorkflows({ workflowName: RUN_EXTRACTION, authenticatedUser: project.researcherAccountId }), [])
    if (suggested) assert.deepEqual(await db.orm.public.BatchSchemaSuggestion.select('confirmedSchemaRevisionId', 'batchExtractionId').first({ id: suggestionId }),
      { confirmedSchemaRevisionId: null, batchExtractionId: null })
    assert.equal((await run()).disposition, 'created')
  })

  it('batch admission locks members in sorted order and creates one pending Extraction per member with a deterministic ID', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['b.pdf', 'a.pdf', 'c.pdf'])
    const module = scheduler(project.researcherAccountId)
    kei.holding = true
    await configureAccount(project.researcherAccountId, { extractionModels: { fields: 'nuextract' } })
    const sorted = project.documents.map((document) => document.sourceDocumentId).sort((left, right) => left.localeCompare(right))
    /** Holds one member's document row, admits a batch over the members in reverse order, and reports which other
     *  members the admission had locked when it blocked. */
    async function lockedWhileHolding(held: string) {
      const holder = new pg.Client({ connectionString: disposableDatabaseUrl! })
      const prober = new pg.Client({ connectionString: disposableDatabaseUrl! })
      await holder.connect()
      await prober.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM "sourceDocument" WHERE id = $1 FOR UPDATE', [held])
        const scheduling = module.scheduleBatch({
          projectContextId: project.projectContextId,
          schemaRevisionId: project.schemaRevisionId,
          strategy: 'ARTICLE',
          sourceDocumentIds: [...sorted].reverse(),
          repetition: 'create-new',
          method: { models: { fields: 'nuextract' }, settings: { article: null } },
        })
        void scheduling.catch(() => {})
        await eventually(async () => {
          await prober.query('SELECT pg_stat_clear_snapshot()')
          const { rows } = await prober.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()
               AND wait_event_type = 'Lock' AND query ILIKE '%UPDATE%"sourceDocument"%'`)
          return rows[0]!.count
        }, (count) => count === 1, 'the batch admission waits on the held document')
        const locked: string[] = []
        for (const id of sorted.filter((candidate) => candidate !== held)) {
          await prober.query('BEGIN')
          try {
            await prober.query('SELECT id FROM "sourceDocument" WHERE id = $1 FOR UPDATE NOWAIT', [id])
          } catch (error) {
            if ((error as { code?: string }).code !== '55P03') throw error
            locked.push(id)
          } finally {
            await prober.query('ROLLBACK')
          }
        }
        await holder.query('COMMIT')
        return { locked, scheduled: await scheduling }
      } finally {
        await holder.query('ROLLBACK').catch(() => {})
        await holder.end()
        await prober.end()
      }
    }
    // Holding the smallest ID stops the admission before it locks anything else; holding the largest, after it
    // locked every other member.
    assert.deepEqual((await lockedWhileHolding(sorted[0]!)).locked, [])
    const { locked, scheduled } = await lockedWhileHolding(sorted[2]!)
    assert.deepEqual(locked, sorted.slice(0, 2))
    const batchExtractionId = scheduled.batch.batchExtractionId
    assert.equal(scheduled.disposition, 'created')
    assert.deepEqual(scheduled.batch.members.map((member) => member.sourceDocumentId), sorted)
    const rows = await db.orm.public.Extraction.where({ batchExtractionId })
      .select('id', 'sourceDocumentId', 'outcome', 'requestedModels', 'catalogRecipe').all()
    assert.equal(rows.length, 3)
    for (const row of rows) {
      assert.equal(row.id, stableUuid('batch-member-extraction', stableJson([batchExtractionId, row.sourceDocumentId])))
      assert.equal(row.outcome, null)
      assert.equal(row.catalogRecipe, null)
      assert.deepEqual(row.requestedModels, { fields: 'nuextract' })
    }
    const workflows = await app.admission.listWorkflows({ workflowIDs: rows.map((row) => `extract:${row.id}`) })
    assert.equal(workflows.length, 3)
    for (const workflow of workflows) {
      assert.equal(workflow.workflowName, RUN_EXTRACTION)
      assert.equal(workflow.queueName, 'studio')
      assert.equal(workflow.authenticatedUser, project.researcherAccountId)
      assert.equal(workflow.attributes?.batchExtractionId, batchExtractionId)
    }
    // Members reach kei at the batch priority.
    for (const row of rows) await heldByKei(row.id)
    const submitted = kei.submissions.filter((submission) => rows.some((row) => submission.workflowId === keiExtractWorkflowId(row.id)))
    assert.equal(submitted.length, 3)
    assert.ok(submitted.every((submission) => submission.priority === 10))
  })

it('a committed batch answers with its admitted members even when DBOS cannot be read, and a retry adds no batch', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf', 'two.pdf'])
    const outage = new Error('connect ECONNREFUSED: DBOS is unavailable')
    const unreadable: ExtractionExecution = { ...execution, statuses: async () => { throw outage } }
    const module = createExtractionModule(
      createResearcherExtractionPersistence(project.researcherAccountId, unreadable, { database: db as Database, packages }),
    )
    const batches = async () =>
      (await db.orm.public.BatchExtraction.where({ projectContextId: project.projectContextId }).select('id').all()).length
    const input = {
      projectContextId: project.projectContextId,
      schemaRevisionId: project.schemaRevisionId,
      strategy: 'ARTICLE' as const,
      sourceDocumentIds: project.documents.map((document) => document.sourceDocumentId),
      method: SERVICE_DEFAULTS,
    }
    for (const repetition of ['create-new', 'reuse-equal-selection'] as const) {
      const before = await batches()
      const created = await module.scheduleBatch({ ...input, repetition })
      assert.equal(created.disposition, 'created')
      assert.equal(created.batch.executionStatus, 'QUEUED')
      assert.deepEqual(created.batch.members.map((member) => member.executionStatus), ['QUEUED', 'QUEUED'])
      assert.equal(await batches(), before + 1)
    }
    // A replay reads its status like any read, so the outage still answers; it creates nothing.
    await assert.rejects(module.scheduleBatch({ ...input, repetition: 'reuse-equal-selection' }), (error: unknown) => error === outage)
    assert.equal(await batches(), 2)

    // A suggested batch's handoff answers the same way.
    const batchSchemaSuggestionId = randomUUID()
    await db.orm.public.BatchSchemaSuggestion.create({
      id: batchSchemaSuggestionId,
      projectContextId: project.projectContextId,
      selectionKey: sha256(strToU8(batchSchemaSuggestionId)),
    })
    for (const document of project.documents)
      await db.orm.public.BatchSchemaSuggestionSource.create({
        batchSchemaSuggestionId,
        sourceDocumentId: document.sourceDocumentId,
        sourceRepresentationRevisionId: document.sourceRepresentationRevisionId,
      })
    await db.orm.public.BatchSchemaSuggestion.where({ id: batchSchemaSuggestionId }).update({
      outcome: 'SUCCEEDED', phase: 'READY', draft: ARTICLE_SCHEMA, draftVersion: 1,
    })
    const handedOff = await module.scheduleSuggestedBatch({
      projectContextId: project.projectContextId, batchSchemaSuggestionId, strategy: 'ARTICLE', method: SERVICE_DEFAULTS,
    })
    assert.equal(handedOff.disposition, 'created')
    assert.deepEqual(handedOff.batch.members.map((member) => member.executionStatus), ['QUEUED', 'QUEUED'])
    assert.equal(await batches(), 3)
  })

it('a batch rerun creates new Extraction identities', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf', 'two.pdf'])
    const module = scheduler(project.researcherAccountId)
    const input = {
      projectContextId: project.projectContextId,
      schemaRevisionId: project.schemaRevisionId,
      strategy: 'ARTICLE' as const,
      sourceDocumentIds: project.documents.map((document) => document.sourceDocumentId),
      repetition: 'create-new' as const,
      method: SERVICE_DEFAULTS,
    }
    const first = await module.scheduleBatch(input)
    const second = await module.scheduleBatch(input)
    const ids = async (batchExtractionId: string) =>
      (await db.orm.public.Extraction.where({ batchExtractionId }).select('id').all()).map((row) => row.id)
    const firstIds = await ids(first.batch.batchExtractionId)
    const secondIds = await ids(second.batch.batchExtractionId)
    assert.equal(firstIds.length, 2)
    assert.equal(secondIds.length, 2)
    assert.ok(firstIds.every((id) => !secondIds.includes(id)))
  })

it('pending Extractions count as batch members but do not displace the latest reviewed result on reopen', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const document = project.documents[0]!
    const { module } = createRuntime(project.researcherAccountId)
    const reviewed = await module.runSingle(freshInput(project))
    const prepared = await module.prepareReview(reviewed.extraction.extractionId)
    await module.finalizeReview(reviewed.extraction.extractionId, prepared.reviewDecisions)
    kei.holding = true
    const scheduled = await module.scheduleBatch({
      projectContextId: project.projectContextId,
      schemaRevisionId: project.schemaRevisionId,
      strategy: 'ARTICLE',
      sourceDocumentIds: [document.sourceDocumentId],
      repetition: 'create-new',
      method: SERVICE_DEFAULTS,
    })
    const member = stableUuid('batch-member-extraction', stableJson([scheduled.batch.batchExtractionId, document.sourceDocumentId]))
    await heldByKei(member)
    const batch = await module.readBatch({
      projectContextId: project.projectContextId, batchExtractionId: scheduled.batch.batchExtractionId,
    })
    assert.equal(batch.members.length, 1)
    assert.equal(batch.members[0]!.executionStatus, 'RUNNING')
    assert.equal(batch.members[0]!.latestExtraction, null)
    const reopened = await module.readDocumentExtractions({ sourceDocumentId: document.sourceDocumentId })
    assert.equal(reopened?.latestReviewed?.extractionId, reviewed.extraction.extractionId)
    assert.equal(reopened?.latestAttempt?.extractionId, reviewed.extraction.extractionId)
    const results = await module.readBatchResults({
      projectContextId: project.projectContextId, batchExtractionId: scheduled.batch.batchExtractionId,
    })
    assert.deepEqual({ total: results.totalMembers, pending: results.pending, results: results.results.length },
      { total: 1, pending: 1, results: 0 })
    // The project list counts the pending member as batch progress, not as a published Extraction.
    const listed = await createResearcherProjectStore(project.researcherAccountId, db, { workflowStatuses: execution.statuses })
      .listProjectContexts(20)
    const summary = listed.find((item) => item.projectContextId === project.projectContextId)?.summary
    assert.equal(summary?.extractionCount, 1)
    assert.equal(summary?.reviewedSourceDocumentCount, 1)
    assert.deepEqual(summary?.runningBatch, { completedMemberCount: 0, memberCount: 1 })
    const activity = await createResearcherProjectStore(project.researcherAccountId, db).listRecentActivity(20)
    assert.equal(activity.filter((event) => event.kind === 'extraction_appended').length, 1)
  })

it('a batch member cannot be cancelled on its own, and its ID posted as an interactive Extraction answers extraction_id_conflict', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const document = project.documents[0]!
    const module = scheduler(project.researcherAccountId)
    kei.holding = true
    const scheduled = await module.scheduleBatch({
      projectContextId: project.projectContextId,
      schemaRevisionId: project.schemaRevisionId,
      strategy: 'ARTICLE',
      sourceDocumentIds: [document.sourceDocumentId],
      repetition: 'create-new',
      method: SERVICE_DEFAULTS,
    })
    const member = stableUuid('batch-member-extraction', stableJson([scheduled.batch.batchExtractionId, document.sourceDocumentId]))
    assert.equal(await module.cancelSingle(member), 'not-found')
    assert.equal((await extractionRow(member))?.outcome, null)
    await assert.rejects(module.runSingle(freshInput(project, member)), rejectsWithCode('extraction_id_conflict'))
  })

it('batch results name a contested empty value from the stored diagnostics until a review settles it', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['contested.pdf'])
    const [document] = project.documents as [SeededDocument]
    const module = scheduler(project.researcherAccountId)
    const scheduled = await module.scheduleBatch({
      projectContextId: project.projectContextId, schemaRevisionId: project.schemaRevisionId,
      strategy: 'ARTICLE', sourceDocumentIds: [document.sourceDocumentId], repetition: 'create-new', method: SERVICE_DEFAULTS,
    })
    const batchExtractionId = scheduled.batch.batchExtractionId
    await waitForBatch(module, project.projectContextId, batchExtractionId, (candidate) => candidate.executionStatus === 'COMPLETED')
    const id = stableUuid('batch-member-extraction', stableJson([batchExtractionId, document.sourceDocumentId]))
    const stored = await db.orm.public.Extraction.select('resultPayload', 'diagnostics').first({ id })
    const records = (stored!.resultPayload as { records: Record<string, unknown>[] }).records
    const field = Object.keys(records[0]!)[0]!
    // As kei-exp's Article reports a scalar its value contexts disagreed on: null, with its candidates in an issue.
    const issue = { code: 'conflicting_values', detail: JSON.stringify({ path: [field], candidates: ['A', 'B'] }), record: 0, path: null }
    const diagnostics = stored!.diagnostics as Record<string, unknown>
    await db.orm.public.Extraction.where({ id }).updateAll({
      resultPayload: { records: [{ ...records[0], [field]: null }, ...records.slice(1)] },
      diagnostics: { ...diagnostics, groundingIssues: [...(diagnostics.groundingIssues as unknown[] ?? []), issue] },
    })
    const read = () => module.readBatchResults({ projectContextId: project.projectContextId, batchExtractionId })
    assert.deepEqual((await read()).results[0]!.contested, [{ resultPath: ['records', 0, field], candidates: ['A', 'B'] }])

    // A review that rejected the field settles it (as the Results tab shows it): nothing is left contested.
    await db.orm.public.Extraction.where({ id }).updateAll({ reviewedAt: new Date() })
    const review = await db.orm.public.ExtractionReview.create({ extractionId: id, revisionNumber: 1, decisionDigest: '[]' })
    await db.orm.public.ReviewDecision.create({
      extractionReviewId: review.id, resultPath: ['records', 0, field], resultPathKey: JSON.stringify(['records', 0, field]),
      evidenceAnchorId: 'none', reviewedOccurrenceIds: [], action: 'REJECTED', reviewedValue: null,
    })
    assert.equal((await read()).results[0]!.contested, undefined)
  })

it('deleting one batch source preserves another member\'s result, revision pin and finalized review', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['deleted.pdf', 'kept.pdf'])
    const [deleted, kept] = project.documents as [SeededDocument, SeededDocument]
    const module = scheduler(project.researcherAccountId)
    const store = createResearcherProjectStore(project.researcherAccountId, db)
    const scheduled = await module.scheduleBatch({
      projectContextId: project.projectContextId, schemaRevisionId: project.schemaRevisionId,
      strategy: 'ARTICLE', sourceDocumentIds: [deleted.sourceDocumentId, kept.sourceDocumentId], repetition: 'create-new',
      method: SERVICE_DEFAULTS,
    })
    const batchExtractionId = scheduled.batch.batchExtractionId
    await waitForBatch(module, project.projectContextId, batchExtractionId,
      (candidate) => candidate.executionStatus === 'COMPLETED')
    const keptId = stableUuid('batch-member-extraction', stableJson([batchExtractionId, kept.sourceDocumentId]))
    const prepared = await module.prepareReview(keptId)
    await module.finalizeReview(keptId, prepared.reviewDecisions)
    const keptBefore = await db.orm.public.Extraction.select('id', 'sourceRepresentationRevisionId', 'outcome', 'resultPayload').first({ id: keptId })
    const reviewsBefore = await db.orm.public.ExtractionReview.where({ extractionId: keptId })
      .select('id', 'decisionDigest').all()
    assert.ok(reviewsBefore.length > 0)

    assert.deepEqual(await store.deleteSourceDocument(project.projectContextId, deleted.sourceDocumentId), { interruptedAttempts: [] })
    assert.deepEqual(await db.orm.public.Extraction.select('id', 'sourceRepresentationRevisionId', 'outcome', 'resultPayload').first({ id: keptId }), keptBefore)
    assert.deepEqual(await db.orm.public.ExtractionReview.where({ extractionId: keptId })
      .select('id', 'decisionDigest').all(), reviewsBefore)
    const batch = await module.readBatch({ projectContextId: project.projectContextId, batchExtractionId })
    assert.deepEqual(batch.members.map((member) => member.sourceDocumentId), [kept.sourceDocumentId])
  })

it('stores batch model choices on every member Extraction and includes them in selection identity', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf', 'two.pdf'])
    const module = scheduler(project.researcherAccountId)
    const input = {
      projectContextId: project.projectContextId,
      schemaRevisionId: project.schemaRevisionId,
      strategy: 'ARTICLE' as const,
      sourceDocumentIds: project.documents.map(document => document.sourceDocumentId),
      repetition: 'reuse-equal-selection' as const,
    }
    const method = (models: Record<string, string> | null): ExtractionMethodIntent => ({ models, settings: { article: null } })
    // The identity an equal selection had before methods were recorded. Such a batch's method is not recorded, so no
    // request replays it: the selection always hashes the method.
    const hash = createHash('sha256').update(JSON.stringify([
      input.projectContextId, input.schemaRevisionId, input.strategy,
      [...input.sourceDocumentIds].sort((left, right) => left.localeCompare(right)),
    ])).digest('hex')
    const variant = ['8', '9', 'a', 'b'][parseInt(hash[16]!, 16) & 3]
    const unrecordedId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
    const defaults = await module.scheduleBatch({ ...input, method: method(null) })
    assert.equal(defaults.disposition, 'created')
    assert.notEqual(defaults.batch.batchExtractionId, unrecordedId)
    // No choice and an empty choice are the same request; an empty model key is no choice at all.
    const replay = await module.scheduleBatch({ ...input, method: method({}) })
    assert.equal(replay.disposition, 'replayed')
    assert.equal(replay.batch.batchExtractionId, defaults.batch.batchExtractionId)
    await assert.rejects(module.scheduleBatch({ ...input, method: method({ fields: '' }) }), rejectsWithCode('invalid_request'))
    const ids = new Set([defaults.batch.batchExtractionId])
    for (const models of [null, { fields: 'nuextract', reasoning: 'instruct' },
      { fields: 'instruct', reasoning: 'instruct' }, { fields: 'nuextract', reasoning: 'other' }]) {
      await configureAccount(project.researcherAccountId, { extractionModels: models ?? {} })
      const scheduled = await module.scheduleBatch({ ...input, method: method(models) })
      const batchExtractionId = scheduled.batch.batchExtractionId
      if (models) {
        assert.equal(scheduled.disposition, 'created')
        assert.ok(!ids.has(batchExtractionId))
        ids.add(batchExtractionId)
        const replay = await module.scheduleBatch({
          ...input, sourceDocumentIds: [...input.sourceDocumentIds].reverse(),
          method: method({ reasoning: models.reasoning, fields: models.fields }),
        })
        assert.equal(replay.disposition, 'replayed')
        assert.equal(replay.batch.batchExtractionId, batchExtractionId)
      }
      await waitForBatch(module, project.projectContextId, batchExtractionId, batch => batch.executionStatus === 'COMPLETED')
      const members = await db.orm.public.Extraction.where({ batchExtractionId })
        .select('id', 'requestedModels', 'outcome').all()
      assert.equal(members.length, project.documents.length)
      for (const member of members) {
        assert.deepEqual(member.requestedModels, models)
        assert.equal(member.outcome, 'SUCCEEDED')
        const submission = kei.submissions.find((candidate) => candidate.workflowId === keiExtractWorkflowId(member.id))!
        assert.deepEqual((submission.request as KeiExtractInput).request.options.models ?? null, models)
      }
    }
  })

it('rejects duplicate members, atomically pins valid members, replays equal selections, and creates explicit repetitions', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['b.pdf', 'a.pdf'])
    const foreign = await seedProject()
    const module = scheduler(project.researcherAccountId)
    const selected = [
      project.documents[1]!.sourceDocumentId,
      project.documents[0]!.sourceDocumentId,
    ]
    const input = {
      projectContextId: project.projectContextId,
      schemaRevisionId: project.schemaRevisionId,
      strategy: 'ARTICLE' as const,
      sourceDocumentIds: selected,
      repetition: 'reuse-equal-selection' as const,
      method: SERVICE_DEFAULTS,
    }

    await assert.rejects(
      module.scheduleBatch({
        ...input,
        sourceDocumentIds: [...selected, selected[0]!],
      }),
      rejectsWithCode('invalid_extraction_pins'),
    )
    const created = await module.scheduleBatch(input)
    assert.equal(created.disposition, 'created')
    assert.deepEqual(
      created.batch.members.map((member) => member.sourceDocumentId),
      [...new Set(selected)].sort(),
    )
    const originalPins = created.batch.members.map((member) =>
      member.sourceRepresentationRevisionId,
    )
    await addRepresentation(project.documents[0]!, 'b-v2.pdf')
    await addRepresentation(project.documents[1]!, 'a-v2.pdf')

    const replayed = await module.scheduleBatch(input)
    assert.equal(replayed.disposition, 'replayed')
    assert.equal(
      replayed.batch.batchExtractionId,
      created.batch.batchExtractionId,
    )
    assert.deepEqual(
      replayed.batch.members.map((member) =>
        member.sourceRepresentationRevisionId,
      ),
      originalPins,
    )

    const repeatedInput = { ...input, repetition: 'create-new' as const }
    const firstRepeat = await module.scheduleBatch(repeatedInput)
    const secondRepeat = await module.scheduleBatch(repeatedInput)
    assert.notEqual(
      firstRepeat.batch.batchExtractionId,
      secondRepeat.batch.batchExtractionId,
    )
    assert.ok(
      firstRepeat.batch.members.every(
        (member) => !originalPins.includes(member.sourceRepresentationRevisionId),
      ),
    )

    const before = await module.listBatches({
      projectContextId: project.projectContextId,
    })
    await assert.rejects(
      module.scheduleBatch({
        ...input,
        sourceDocumentIds: [
          project.documents[0]!.sourceDocumentId,
          foreign.documents[0]!.sourceDocumentId,
        ],
        repetition: 'create-new',
      }),
      rejectsWithCode('not_found'),
    )
    const after = await module.listBatches({
      projectContextId: project.projectContextId,
    })
    assert.equal(after.length, before.length)
    const foreignModule = scheduler(foreign.researcherAccountId)
    const foreignBatch = await foreignModule.scheduleBatch({
      projectContextId: foreign.projectContextId,
      schemaRevisionId: foreign.schemaRevisionId,
      strategy: 'ARTICLE',
      sourceDocumentIds: [
        foreign.documents[0]!.sourceDocumentId,
      ],
      repetition: 'create-new',
      method: SERVICE_DEFAULTS,
    })
    await assert.rejects(
      module.listBatches({
        projectContextId: foreign.projectContextId,
      }),
      rejectsWithCode('not_found'),
    )
    for (const projectContextId of [
      project.projectContextId,
      foreign.projectContextId,
    ]) {
      await assert.rejects(
        module.readBatch({
          projectContextId,
          batchExtractionId:
            foreignBatch.batch.batchExtractionId,
        }),
        rejectsWithCode('not_found'),
      )
      await assert.rejects(
        module.readBatchResults({
          projectContextId,
          batchExtractionId:
            foreignBatch.batch.batchExtractionId,
        }),
        rejectsWithCode('not_found'),
      )
    }
    const completedForeign = await waitForBatch(
      foreignModule,
      foreign.projectContextId,
      foreignBatch.batch.batchExtractionId,
      (batch) => batch.executionStatus === 'COMPLETED',
    )
    assert.equal(completedForeign.executionStatus, 'COMPLETED')
    const results = await foreignModule.readBatchResults({
      projectContextId: foreign.projectContextId, batchExtractionId: foreignBatch.batch.batchExtractionId,
    })
    assert.deepEqual([results.successfulResults, results.pending, results.failed, results.cancelled], [1, 0, 0, 0])
  })

it('counts a member kei cancelled as cancelled and an interrupted one as failed', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['cancelled.pdf', 'interrupted.pdf'])
    const [cancelled, interrupted] = project.documents as [SeededDocument, SeededDocument]
    const module = scheduler(project.researcherAccountId)
    kei.holding = true
    const scheduled = await module.scheduleBatch({
      projectContextId: project.projectContextId,
      schemaRevisionId: project.schemaRevisionId,
      strategy: 'ARTICLE',
      sourceDocumentIds: project.documents.map((document) => document.sourceDocumentId),
      repetition: 'create-new',
      method: SERVICE_DEFAULTS,
    })
    const batchExtractionId = scheduled.batch.batchExtractionId
    const memberOf = (document: SeededDocument) =>
      stableUuid('batch-member-extraction', stableJson([batchExtractionId, document.sourceDocumentId]))
    await heldByKei(memberOf(cancelled))
    await heldByKei(memberOf(interrupted))
    // kei's own cancel of a child settles the member FAILED with code `cancelled`.
    await kei.handoff.cancel(keiExtractWorkflowId(memberOf(cancelled)))
    // A Studio workflow stopped without an outcome leaves its member interrupted.
    await DBOS.cancelWorkflow(`extract:${memberOf(interrupted)}`)
    await eventually(() => extractionRow(memberOf(cancelled)), (row) => row?.outcome === 'FAILED', 'the cancelled member settles')
    const results = await module.readBatchResults({ projectContextId: project.projectContextId, batchExtractionId })
    assert.deepEqual([results.totalMembers, results.pending, results.failed, results.cancelled], [2, 0, 1, 1])
    assert.equal(results.executionStatus, 'COMPLETED')
    const batch = await module.readBatch({ projectContextId: project.projectContextId, batchExtractionId })
    assert.deepEqual(batch.members.map((member) => [member.executionStatus, member.failureMessage]).sort(), [
      ['FAILED', 'The Extraction was cancelled.'],
      ['FAILED', 'This work stopped before it finished. Start it again.'],
    ])
  })

  const SPANS = {
    context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
    prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema',
  } as const
  const QUOTES = { ...SPANS, grounding: 'quoted' } as const
  const batchInput = (project: SeededProject, method: unknown, repetition: BatchRepetition = 'reuse-equal-selection') => ({
    projectContextId: project.projectContextId, schemaRevisionId: project.schemaRevisionId, strategy: 'ARTICLE' as const,
    sourceDocumentIds: project.documents.map((document) => document.sourceDocumentId), repetition, method: method as never,
  })

  it('one batch-level method is pinned on the batch and every member', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['a.pdf', 'b.pdf'])
    kei.holding = true
    await configureAccount(project.researcherAccountId, { extractionModels: { fields: 'instruct' }, extractionSettings: { article: SPANS } })
    const method = { models: { fields: 'instruct' }, settings: { article: SPANS } }
    const opened = await scheduler(project.researcherAccountId).scheduleBatch(batchInput(project, method))
    const batch = await db.orm.public.BatchExtraction.select('requestedModels', 'requestedSettings').first({ id: opened.batch.batchExtractionId })
    assert.deepEqual(batch, { requestedModels: { fields: 'instruct' }, requestedSettings: { article: SPANS } })
    const members = await db.orm.public.Extraction.where({ batchExtractionId: opened.batch.batchExtractionId }).select('requestedModels', 'requestedSettings').all()
    assert.equal(members.length, 2)
    for (const member of members) assert.deepEqual(member, { requestedModels: { fields: 'instruct' }, requestedSettings: { article: SPANS } })
  })

  it('equal selection reuses only an equal active method; an inactive strategy change still reuses', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['a.pdf', 'b.pdf'])
    kei.holding = true
    const module = scheduler(project.researcherAccountId)
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: SPANS } })
    const first = await module.scheduleBatch(batchInput(project, { models: null, settings: { article: SPANS } }))
    assert.equal((await module.scheduleBatch(batchInput(project, { models: null, settings: { article: SPANS } }))).batch.batchExtractionId,
      first.batch.batchExtractionId)
    // Only the schedule changes: a different selection.
    const unscheduled = { ...SPANS, grounding_schedule: undefined }
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: unscheduled } })
    const changed = await module.scheduleBatch(batchInput(project, { models: null, settings: { article: unscheduled } }))
    assert.notEqual(changed.batch.batchExtractionId, first.batch.batchExtractionId)
    assert.equal(changed.disposition, 'created')
    // Only the inactive (Catalog) settings change: the same selection.
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: unscheduled, catalog: { generic: { record_chars: 30000 } } } })
    const reused = await module.scheduleBatch(batchInput(project, { models: null, settings: { article: unscheduled } }))
    assert.equal(reused.batch.batchExtractionId, changed.batch.batchExtractionId)
    assert.equal(reused.disposition, 'replayed')
  })

  it('a retried batch request replays its batch after the account changes; a stale fresh request admits nothing', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['a.pdf', 'b.pdf'])
    kei.holding = true
    const module = scheduler(project.researcherAccountId)
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: SPANS } })
    const input = batchInput(project, { models: null, settings: { article: SPANS } })
    const opened = await module.scheduleBatch(input)
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: QUOTES } })
    assert.equal((await module.scheduleBatch(input)).disposition, 'replayed')
    await assert.rejects(module.scheduleBatch({ ...input, repetition: 'create-new' }), rejectsWithCode('method_changed'))
    assert.equal((await db.orm.public.BatchExtraction.where({ projectContextId: project.projectContextId }).select('id').all()).length, 1)
    assert.equal(opened.batch.members.length, 2)
  })

  it('an identical request that waited for the first admission replays it, even when an Apply commits in between', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['a.pdf', 'b.pdf'])
    kei.holding = true
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: SPANS } })
    const input = batchInput(project, { models: null, settings: { article: SPANS } })
    const admitted = Promise.withResolvers<number>()
    const releaseFirst = Promise.withResolvers<void>()
    // The first admission pauses in its enqueue, holding its Source Document rows and the configuration row.
    const barrier: ExtractionExecution = {
      ...execution,
      async enqueue(client, workflow, workflowInput) {
        admitted.resolve((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
        await releaseFirst.promise
        await execution.enqueue(client, workflow, workflowInput)
      },
    }
    const first = createExtractionModule(
      createResearcherExtractionPersistence(project.researcherAccountId, barrier, { database: db as Database, packages }))
      .scheduleBatch(input)
    const applyHolds = Promise.withResolvers<void>()
    const releaseApply = Promise.withResolvers<void>()
    let second: Promise<{ disposition: string }> | undefined
    let applying: Promise<unknown> | undefined
    try {
      const firstPid = await untilSignalled(admitted.promise, first, 'the first admission holds its locks')
      second = scheduler(project.researcherAccountId).scheduleBatch(input)
      await untilLockWait(second, '%', firstPid)
      applying = modelConfigurations.apply(project.researcherAccountId, async (previous) => {
        applyHolds.resolve()
        await releaseApply.promise
        return { ...(previous as object), extractionSettings: { article: QUOTES } }
      })
      await untilLockWait(applying, '%"modelConfiguration"%', firstPid)
      releaseFirst.resolve()
      assert.equal((await first).disposition, 'created')
      // The Apply now holds the configuration row with the new settings not yet committed; it commits next.
      await untilSignalled(applyHolds.promise, applying, 'the Apply holds the configuration lock')
      releaseApply.resolve()
      await applying
      assert.equal((await second).disposition, 'replayed')
    } finally {
      // A failed assertion must not leave a gate closed: released, every transaction settles.
      releaseFirst.resolve()
      releaseApply.resolve()
      await first.catch(() => {})
      await applying?.catch(() => {})
      await second?.catch(() => {})
    }
    assert.equal((await db.orm.public.BatchExtraction.where({ projectContextId: project.projectContextId }).select('id').all()).length, 1)
  })

  it('a batch whose identity fields the schema lacks is refused whole before enqueue', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['a.pdf', 'b.pdf'])
    const declared = { ...REFERENCE_ARTICLE, identity: 'conservative', identity_fields: ['species'] }
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: declared } })
    await assert.rejects(scheduler(project.researcherAccountId).scheduleBatch(batchInput(project, { models: null, settings: { article: declared } })),
      (error: unknown) => error instanceof ExtractionError && error.code === 'invalid_identity_fields' &&
        error.message === 'These identity fields are not scalar record fields of the selected Schema Revision: species (not in this schema).')
    assert.equal((await db.orm.public.BatchExtraction.where({ projectContextId: project.projectContextId }).select('id').all()).length, 0)
    assert.equal(kei.submissions.length, 0)
  })

  it('recipe settings are refused for a batch, which has no recipe', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    await assert.rejects(scheduler(project.researcherAccountId).scheduleBatch({
      ...batchInput(project, { models: null, settings: { recipe: null } }), strategy: 'CATALOG',
    }), rejectsWithCode('invalid_request'))
  })

  it('queued batch members keep the batch method after the account saves another one', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['a.pdf', 'b.pdf'])
    kei.holding = true
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: SPANS } })
    // Every member's workflow waits just before it loads its admitted method, so the account changes first.
    const original = ports.current
    const gate = Promise.withResolvers<void>()
    const loading: string[] = []
    ports.current = {
      ...original,
      store: {
        ...original.store,
        async loadAdmitted(extractionId) {
          loading.push(extractionId)
          await gate.promise
          return original.store.loadAdmitted(extractionId)
        },
      },
    }
    try {
      const opened = await scheduler(project.researcherAccountId).scheduleBatch(batchInput(project, { models: null, settings: { article: SPANS } }))
      await eventually(async () => loading.length, (count) => count > 0, 'a member waits to load its method')
      assert.equal(kei.submissions.length, 0)
      await configureAccount(project.researcherAccountId, { extractionSettings: { article: QUOTES } })
      gate.resolve()
      const members = await db.orm.public.Extraction.where({ batchExtractionId: opened.batch.batchExtractionId }).select('id').all()
      assert.equal(members.length, 2)
      for (const member of members) await heldByKei(member.id)
      for (const member of members) {
        const submitted = kei.submissions.find((submission) => submission.workflowId === keiExtractWorkflowId(member.id))!
        assert.deepEqual(((submitted.request as KeiExtractInput).request.options as { article: unknown }).article, SPANS)
      }
    } finally {
      gate.resolve()
      ports.current = original
    }
  })
})
