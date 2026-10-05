/**
 * The record-scope release read through the extraction package on history it did not write: a fresh database migrated
 * by the real runner to the migration before `schema_revision_record_scope`, seeded as the previous release stored
 * Extractions, results, reviews and batches, then migrated forward before current readers run. Admission replays what was
 * admitted before and refuses new work on a revision whose scope is undeclared or names the other strategy.
 *
 * `db` binds its pool to DATABASE_URL when it is first imported, so every module that imports it is imported only after
 * DATABASE_URL names the provisioned database (each test file runs in its own process).
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'
import { Client } from 'pg'
import {
  ARTICLE_DECISIONS, ARTICLE_EVIDENCE, ARTICLE_OCCURRENCES, ARTICLE_RESULT, CATALOG_DECISIONS, CATALOG_RESULT, migrate,
  provisionDatabase, RECORD_SCOPE_MIGRATION, seedPreMigrationHistory, snapshotHistory, type History,
} from '../../db/src/record-scope-history-fixture.js'
import type { ExtractionExecution } from './dependencies.js'
import { ExtractionError } from './errors.js'
import { canonicalIntent } from './extraction-method.js'
import { normalizeDecisions } from './review-rules.js'
import type { ExtractionStrategy, ScheduleBatchInput } from './types.js'

const baseUrl = process.env.EXTRACTION_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? process.env.PROJECT_STORE_POSTGRES_URL

/** The identity admission gives a reused batch selection (`postgres-admission.ts` `selectionId`), so a seeded batch is
 *  the one an identical request names. */
function selectionId(input: { projectContextId: string; schemaRevisionId: string; strategy: string; sourceDocumentIds: string[] }, method: unknown) {
  const hash = createHash('sha256').update(JSON.stringify([
    input.projectContextId, input.schemaRevisionId, input.strategy,
    [...new Set(input.sourceDocumentIds)].sort((left, right) => left.localeCompare(right)), method,
  ])).digest('hex')
  const variant = (['8', '9', 'a', 'b'] as const)[parseInt(hash[16]!, 16) & 3]
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

describe('the record-scope release on pre-migration history', { skip: !baseUrl && 'set EXTRACTION_TEST_DATABASE_URL (or DATABASE_URL) to a disposable free_test_* database on the test server' }, () => {
  if (!baseUrl) return

  it('reads historical Extractions, reviews and batch results unchanged, and replays their admissions', async () => {
    const database = await provisionDatabase(baseUrl, 'free_test_record_scope_reads')
    const client = new Client({ connectionString: database.url })
    let closeDb = async () => {}
    after(async () => {
      try { await closeDb(); await client.end() } finally { await database.drop() }
    })
    await migrate(database.url, `${RECORD_SCOPE_MIGRATION}^`)
    process.env.DATABASE_URL = database.url
    const [{ db, pool, stableJson, stableUuid }, attempts, batches, reviews, admission] = await Promise.all([
      import('db'),
      import('./postgres-attempts.js'),
      import('./postgres-batches.js'),
      import('./postgres-reviews.js'),
      import('./postgres-admission.js'),
    ])
    closeDb = async () => { await db.close(); await pool.end() }
    await client.connect()
    const history: History = await seedPreMigrationHistory(client, {
      digestOf: (decisions) => JSON.stringify(normalizeDecisions(decisions)),
      batchIdOf: (batch) => selectionId(batch, canonicalIntent(batch.method, batch.strategy as ExtractionStrategy, null)),
      memberIdOf: (batchExtractionId, sourceDocumentId) =>
        stableUuid('batch-member-extraction', stableJson([batchExtractionId, sourceDocumentId])),
    })
    const seeded = await snapshotHistory(client)
    const { accountId, projectContextId, documents, revisions, extractions, batches: batchIds, methods } = history
    const extractionIds = [
      ...Object.values(extractions.article), extractions.catalog, ...Object.values(extractions.catalogMembers),
      extractions.bothArticle, ...extractions.bothMembers, extractions.disagree,
    ]
    const consulted: string[] = []
    // DBOS as it would answer for the one unsettled (in-flight) Extraction.
    const statuses = async (workflowIds: readonly string[]) => {
      consulted.push(...workflowIds)
      return new Map(workflowIds.map((id) => [id, 'PENDING']))
    }
    const authority = {
      reviewDecisions: ARTICLE_DECISIONS,
      occurrenceIdsByAnchor: new Map(Object.entries(ARTICLE_OCCURRENCES).map(([anchor, ids]) => [anchor, new Set(ids)])),
      evidenceResultPathKeys: new Set(ARTICLE_EVIDENCE.map((link) => JSON.stringify(link.resultPath))),
    }
    /** Every read path historical rows take: attempt snapshots, a document's attempts, batches and their export
     *  (finalized review decisions applied), the saved draft, and a repeated finalization (digest replay). */
    const read = async () => {
      const derived = await attempts.deriveAttempts(db.orm, statuses, await attempts.readAttemptRows(db.orm, extractionIds))
      const snapshots: Record<string, unknown> = {}
      for (const id of extractionIds) snapshots[id] = await attempts.attemptSnapshot(db.orm, derived.get(id)!)
      const documentReads: Record<string, unknown> = {}
      for (const document of Object.values(documents))
        documentReads[document.sourceDocumentId] = await attempts.loadDocumentExtractions(db.orm, statuses, { sourceDocumentId: document.sourceDocumentId })
      return {
        snapshots,
        documentReads,
        batches: await batches.loadBatches(db.orm, statuses, projectContextId, [batchIds.catalog, batchIds.both]),
        results: {
          catalog: await batches.loadResults(db.orm, statuses, { projectContextId, batchExtractionId: batchIds.catalog }),
          both: await batches.loadResults(db.orm, statuses, { projectContextId, batchExtractionId: batchIds.both }),
        },
        draft: await reviews.readStoredReviewDraft(db, accountId, extractions.catalog),
        replayedReview: await reviews.finalizeStoredReview(db, accountId, extractions.article.reviewed, authority),
      }
    }
    // Forward to the release under test only: later releases are checked by their own migration tests.
    assert.deepEqual((await migrate(database.url, RECORD_SCOPE_MIGRATION)).applied, [RECORD_SCOPE_MIGRATION])
    const scope = async (id: string) =>
      (await client.query('SELECT "recordScope" FROM "schemaRevision" WHERE id = $1', [id])).rows[0].recordScope as string | null
    const backfilled: Array<string | null> = []
    for (const id of [revisions.article, revisions.catalog, revisions.catalogBatch, revisions.both, revisions.never])
      backfilled.push(await scope(id))
    assert.deepEqual(backfilled, ['document', 'records', 'records', null, null])
    // The scoped migration changes no historical bytes. Current startup then
    // completes every migration before using current readers; a missing runtime
    // schema is an error, not a compatibility mode.
    assert.deepEqual(await snapshotHistory(client), seeded)
    await migrate(database.url)
    const currentSeeded = await snapshotHistory(client)
    const afterwards = await read()
    assert.deepEqual(await snapshotHistory(client), currentSeeded)

    // What those reads are, against the seeded history.
    type Snapshot = Awaited<ReturnType<typeof attempts.attemptSnapshot>>
    const snapshot = (id: string) => afterwards.snapshots[id] as Snapshot
    const reviewed = snapshot(extractions.article.reviewed)
    assert.equal(reviewed.executionStatus, 'COMPLETED')
    assert.equal(reviewed.strategy, 'ARTICLE')
    assert.deepEqual(reviewed.requestedModels, { fields: 'nuextract' })
    assert.deepEqual(reviewed.requestedSettings, { article: null })
    // A version 1 Article result keeps both root records: the document scope's one-record rule is never applied to it.
    assert.deepEqual(reviewed.result, ARTICLE_RESULT)
    assert.deepEqual(reviewed.evidence, ARTICLE_EVIDENCE)
    assert.deepEqual(reviewed.reviewDecisions.map(({ createdAt: _, ...decision }) => decision), ARTICLE_DECISIONS)
    const legacy = snapshot(extractions.article.failed)
    assert.equal(legacy.executionStatus, 'FAILED')
    assert.equal(legacy.requestedSettings, null)
    assert.equal(legacy.failure?.code, 'extraction_failed')
    assert.equal(snapshot(extractions.article.inFlight).executionStatus, 'RUNNING')
    assert.deepEqual(consulted.length > 0 && new Set(consulted), new Set([`extract:${extractions.article.inFlight}`]))
    assert.deepEqual(snapshot(extractions.catalog).requestedSettings, { recipe: null })
    assert.equal(snapshot(extractions.catalog).catalogRecipe, history.catalogRecipe)
    // (4) No read reconstructs an old run as having requested a scope.
    assert.doesNotMatch(JSON.stringify(afterwards), /recordScope|record_scope/)
    assert.deepEqual(afterwards.draft, { version: 3, decisions: [CATALOG_DECISIONS[0]] })
    assert.equal(afterwards.replayedReview.status, 'replayed')
    const exported = afterwards.results.catalog!
    assert.deepEqual([exported.totalMembers, exported.successfulResults, exported.failed, exported.cancelled, exported.pending], [3, 1, 1, 1, 0])
    assert.deepEqual(exported.results.map((result) => result.result),
      [{ records: [{ name: 'Anchor (iron)' }, { name: null }, { name: 'Cog' }] }])
    const byJson = (left: unknown, right: unknown) => JSON.stringify(left).localeCompare(JSON.stringify(right))
    assert.deepEqual(afterwards.results.both!.results.map((result) => result.result).sort(byJson), [CATALOG_RESULT, { records: [] }].sort(byJson))

    // (4) Admission: nothing may be enqueued by any request below.
    const execution: ExtractionExecution = {
      enqueue: async () => { throw new Error('A historical replay or a refused admission must not enqueue work.') },
      statuses,
      cancel: async () => { throw new Error('Nothing is cancelled here.') },
    }
    const { d1, d2, d3 } = documents
    const interactive = (document: typeof d1, schemaRevisionId: string, strategy: ExtractionStrategy, method: unknown, extractionId: string = randomUUID()) =>
      admission.admitInteractiveExtraction(execution, accountId, {
        kind: 'fresh', extractionId, sourceRepresentationRevisionId: document.sourceRepresentationRevisionId, schemaRevisionId, strategy,
        method: method as never,
      })
    const refused = (code: string) => (error: unknown) => error instanceof ExtractionError && error.code === code
    // An identical repeat of an admitted Extraction replays: on its backfilled revision and on an ambiguous one alike.
    assert.equal(await interactive(d1, revisions.article, 'ARTICLE', methods.articleWithModels, extractions.article.reviewed), 'replayed')
    assert.equal(await interactive(d1, revisions.both, 'ARTICLE', methods.article, extractions.bothArticle), 'replayed')
    // New work needs a declared scope, and runs only the strategy it names.
    await assert.rejects(interactive(d1, revisions.both, 'ARTICLE', methods.article), refused('record_scope_required'))
    await assert.rejects(interactive(d2, revisions.never, 'CATALOG', methods.generic), refused('record_scope_required'))
    await assert.rejects(interactive(d1, revisions.article, 'CATALOG', methods.generic), refused('record_scope_mismatch'))
    await assert.rejects(interactive(d2, revisions.catalog, 'ARTICLE', methods.article), refused('record_scope_mismatch'))
    // A scope declared against the revision's history: its admitted Extraction still replays; new Article work is refused.
    await client.query('UPDATE "schemaRevision" SET "recordScope" = $1 WHERE id = $2', ['records', revisions.disagree])
    assert.equal(await interactive(d3, revisions.disagree, 'ARTICLE', methods.article, extractions.disagree), 'replayed')
    await assert.rejects(interactive(d3, revisions.disagree, 'ARTICLE', methods.article), refused('record_scope_mismatch'))

    const batch = (schemaRevisionId: string, strategy: ExtractionStrategy, members: Array<typeof d1>, repetition: ScheduleBatchInput['repetition'], method: unknown) =>
      admission.admitBatchExtraction(db, execution, accountId, {
        projectContextId, schemaRevisionId, strategy, method: method as never, repetition,
        sourceDocumentIds: members.map((member) => member.sourceDocumentId),
      })
    const catalogReplay = await batch(revisions.catalogBatch, 'CATALOG', [documents.d4, d3, d2], 'reuse-equal-selection', methods.generic)
    assert.equal(catalogReplay?.disposition, 'replayed')
    assert.equal(catalogReplay?.batch.batchExtractionId, batchIds.catalog)
    const ambiguousReplay = await batch(revisions.both, 'CATALOG', [d2, d3], 'reuse-equal-selection', methods.generic)
    assert.equal(ambiguousReplay?.disposition, 'replayed')
    assert.equal(ambiguousReplay?.batch.batchExtractionId, batchIds.both)
    await assert.rejects(batch(revisions.both, 'CATALOG', [d2, d3], 'create-new', methods.generic), refused('record_scope_required'))
    await assert.rejects(batch(revisions.never, 'ARTICLE', [d2], 'create-new', methods.article), refused('record_scope_required'))
    await assert.rejects(batch(revisions.catalogBatch, 'ARTICLE', [d2], 'create-new', methods.article), refused('record_scope_mismatch'))
    // Nothing was admitted, and history is still as it was stored.
    assert.deepEqual(await snapshotHistory(client), currentSeeded)
  })
})
