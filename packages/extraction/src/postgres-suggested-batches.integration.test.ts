import type { Database } from 'db'
import { strToU8 } from 'fflate'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { createExtractionModule } from './module.js'
import { fixture } from './testing/extraction-fixture.js'

describe('Extraction suggested-batches on disposable PostgreSQL', { skip: !fixture && 'set EXTRACTION_TEST_DATABASE_URL (or DATABASE_URL) to a migrated disposable free_test_* database' }, () => {
  if (!fixture) return
  const {
    sha256, ARTICLE_SCHEMA, db, stableJson, stableUuid,
    createResearcherProjectStore, createResearcherExtractionPersistence, packages, kei, app,
    execution, seedProject, addRepresentation, scheduler, rejectsWithCode,
    succeeded, cleanup,
  } = fixture

  it('a ready suggestion hands its saved pins to one replayable batch of pending member Extractions', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf', 'two.pdf'])
    const module = scheduler(project.researcherAccountId)
    kei.holding = true
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
        sourceRepresentationRevisionId:
          document.sourceRepresentationRevisionId,
      })
    await db.orm.public.BatchSchemaSuggestion.where({
      id: batchSchemaSuggestionId,
    }).update({
      outcome: 'SUCCEEDED',
      phase: 'READY',
      draft: ARTICLE_SCHEMA,
      draftVersion: 1,
    })
    // The suggestion's saved revisions are kept even after a reprocess (PR #140's documented exemption).
    await addRepresentation(project.documents[0]!, 'one-v2.pdf')

    const request = {
      projectContextId: project.projectContextId,
      batchSchemaSuggestionId,
      strategy: 'ARTICLE' as const,
      models: { reasoning: 'instruct', fields: 'nuextract' },
    }
    const handoffs = await Promise.all([
      module.scheduleSuggestedBatch(request),
      module.scheduleSuggestedBatch(request),
    ])
    assert.deepEqual(
      handoffs.map((handoff) => handoff.disposition).sort(),
      ['created', 'replayed'],
    )
    const batchExtractionId = handoffs[0]!.batch.batchExtractionId
    assert.equal(handoffs[1]!.batch.batchExtractionId, batchExtractionId)
    const pins = project.documents
      .map((document) => ({
        sourceDocumentId: document.sourceDocumentId,
        sourceRepresentationRevisionId: document.sourceRepresentationRevisionId,
      }))
      .sort((left, right) => left.sourceDocumentId.localeCompare(right.sourceDocumentId))
    assert.deepEqual(
      handoffs[0]!.batch.members.map((member) => ({
        sourceDocumentId: member.sourceDocumentId,
        sourceRepresentationRevisionId: member.sourceRepresentationRevisionId,
      })),
      pins,
    )
    const members = async () => db.orm.public.Extraction.where({ batchExtractionId })
      .select('id', 'sourceDocumentId', 'sourceRepresentationRevisionId', 'requestedModels', 'outcome').all()
    const rows = await members()
    assert.equal(rows.length, project.documents.length)
    for (const row of rows) {
      assert.equal(row.id, stableUuid('batch-member-extraction', stableJson([batchExtractionId, row.sourceDocumentId])))
      assert.deepEqual(row.requestedModels, request.models)
      assert.equal(row.outcome, null)
    }
    const workflows = () => app.admission.listWorkflows({ workflowIDs: rows.map((row) => `extract:${row.id}`) })
    assert.equal((await workflows()).length, project.documents.length)
    const persisted = await db.orm.public.BatchSchemaSuggestion.select(
      'confirmedSchemaRevisionId',
      'batchExtractionId',
    ).first({ id: batchSchemaSuggestionId })
    assert.ok(persisted?.confirmedSchemaRevisionId)
    assert.equal(persisted.batchExtractionId, batchExtractionId)
    assert.equal(handoffs[0]!.batch.schemaRevisionId, persisted.confirmedSchemaRevisionId)
    for (const row of rows) {
      const [workflow] = await app.admission.listWorkflows({ workflowIDs: [`extract:${row.id}`] })
      assert.equal(workflow?.attributes?.extractionSchemaId, (await db.orm.public.SchemaRevision.select('extractionSchemaId')
        .first({ id: persisted.confirmedSchemaRevisionId }))?.extractionSchemaId)
    }

    // A repeat replays the handoff and adds no rows or workflows.
    const repeated = await module.scheduleSuggestedBatch(request)
    assert.equal(repeated.disposition, 'replayed')
    assert.equal(repeated.batch.batchExtractionId, batchExtractionId)
    assert.equal((await members()).length, project.documents.length)
    assert.equal((await workflows()).length, project.documents.length)
  })

it('rejects invalid stored suggestion drafts inside the atomic batch transaction', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf'])
    const module = scheduler(project.researcherAccountId)
    const invalidDrafts = [
      {
        recordDescription: '   ',
        schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
      },
      {
        recordDescription: 'One invalid record.',
        schemaNodes: [
          { id: 'title-1', name: 'title', type: 'string' },
          { id: 'title-2', name: 'title', type: 'integer' },
        ],
      },
    ]

    for (const draft of invalidDrafts) {
      const batchSchemaSuggestionId = randomUUID()
      await db.orm.public.BatchSchemaSuggestion.create({
        id: batchSchemaSuggestionId,
        projectContextId: project.projectContextId,
        selectionKey: sha256(strToU8(batchSchemaSuggestionId)),
      })
      await db.orm.public.BatchSchemaSuggestionSource.create({
        batchSchemaSuggestionId,
        sourceDocumentId: project.documents[0]!.sourceDocumentId,
        sourceRepresentationRevisionId:
          project.documents[0]!.sourceRepresentationRevisionId,
      })
      await db.orm.public.BatchSchemaSuggestion.where({
        id: batchSchemaSuggestionId,
      }).update({
        outcome: 'SUCCEEDED',
        phase: 'READY',
        draft,
        draftVersion: 1,
      })

      await assert.rejects(
        module.scheduleSuggestedBatch({
          projectContextId: project.projectContextId,
          batchSchemaSuggestionId,
          strategy: 'ARTICLE',
        }),
        rejectsWithCode('batch_not_ready'),
      )
      const persisted = await db.orm.public.BatchSchemaSuggestion.select(
        'confirmedSchemaRevisionId',
        'batchExtractionId',
      ).first({ id: batchSchemaSuggestionId })
      assert.deepEqual(persisted, {
        confirmedSchemaRevisionId: null,
        batchExtractionId: null,
      })
    }

    assert.equal(
      (
        await db.orm.public.BatchExtraction.where({
          projectContextId: project.projectContextId,
        })
          .select('id')
          .all()
      ).length,
      0,
    )
    assert.equal((await db.orm.public.Extraction.where({ sourceDocumentId: project.documents[0]!.sourceDocumentId })
      .select('id').all()).length, 0)
  })

it('Run requires a valid draft, a surviving member and no active attempt', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf', 'two.pdf'])
    /** The DBOS status each suggestion attempt reports; an attempt missing here is gone (interrupted). */
    const attempts = new Map<string, string>()
    const module = createExtractionModule(
      createResearcherExtractionPersistence(project.researcherAccountId, {
        ...execution,
        async statuses(workflowIds) {
          const suggestions = workflowIds.filter((id) => id.startsWith('suggest:'))
          const statuses = new Map(await execution.statuses(workflowIds.filter((id) => !id.startsWith('suggest:'))))
          for (const id of suggestions) if (attempts.has(id)) statuses.set(id, attempts.get(id)!)
          return statuses
        },
      }, { database: db as Database, packages }),
    )
    async function suggestion(fields: Record<string, unknown>, members = project.documents) {
      const batchSchemaSuggestionId = randomUUID()
      await db.orm.public.BatchSchemaSuggestion.create({
        id: batchSchemaSuggestionId,
        projectContextId: project.projectContextId,
        selectionKey: sha256(strToU8(batchSchemaSuggestionId)),
      })
      for (const document of members)
        await db.orm.public.BatchSchemaSuggestionSource.create({
          batchSchemaSuggestionId,
          sourceDocumentId: document.sourceDocumentId,
          sourceRepresentationRevisionId: document.sourceRepresentationRevisionId,
        })
      await db.orm.public.BatchSchemaSuggestion.where({ id: batchSchemaSuggestionId }).update(fields)
      return batchSchemaSuggestionId
    }
    const run = (batchSchemaSuggestionId: string) =>
      module.scheduleSuggestedBatch({ projectContextId: project.projectContextId, batchSchemaSuggestionId, strategy: 'ARTICLE' })
    const unconfirmed = async (batchSchemaSuggestionId: string) =>
      assert.deepEqual(
        await db.orm.public.BatchSchemaSuggestion.select('confirmedSchemaRevisionId', 'batchExtractionId')
          .first({ id: batchSchemaSuggestionId }),
        { confirmedSchemaRevisionId: null, batchExtractionId: null },
      )
    const ready = { phase: 'READY', draft: ARTICLE_SCHEMA, draftVersion: 1 }

    // No draft yet: the first attempt has not published one.
    const drafting = await suggestion({ outcome: 'SUCCEEDED', phase: 'HETEROGENEOUS' })
    await assert.rejects(run(drafting), rejectsWithCode('batch_not_ready'))
    await unconfirmed(drafting)

    // A valid draft with no surviving member (its sources were deleted).
    const empty = await suggestion({ outcome: 'SUCCEEDED', ...ready }, [])
    await assert.rejects(run(empty), rejectsWithCode('batch_not_ready'))
    await unconfirmed(empty)

    // A retained draft while the next attempt runs: its result will replace the draft.
    const retrying = await suggestion({ attempt: 2, outcome: null, ...ready })
    for (const status of ['ENQUEUED', 'PENDING']) {
      attempts.set(`suggest:${retrying}:2`, status)
      await assert.rejects(run(retrying), rejectsWithCode('batch_not_ready'))
      await unconfirmed(retrying)
    }

    // The latest attempt need not have succeeded: a failed or interrupted attempt keeps a valid draft runnable.
    const failed = await suggestion({ attempt: 2, outcome: 'FAILED', failure: { code: 'source_suggestion_failed', message: 'Failed.' }, ...ready })
    assert.equal((await run(failed)).disposition, 'created')
    attempts.set(`suggest:${retrying}:2`, 'CANCELLED')
    assert.equal((await run(retrying)).disposition, 'created')
    const persisted = await db.orm.public.BatchSchemaSuggestion.select('confirmedSchemaRevisionId', 'batchExtractionId')
      .first({ id: retrying })
    assert.ok(persisted?.confirmedSchemaRevisionId)
    assert.ok(persisted.batchExtractionId)

    const removable = await suggestion({ outcome: 'SUCCEEDED', ...ready }, [project.documents[0]!])
    const projectStore = createResearcherProjectStore(project.researcherAccountId, db)
    assert.deepEqual(await projectStore.deleteSourceDocument(project.projectContextId, project.documents[0]!.sourceDocumentId),
      { interruptedAttempts: [] })
    await assert.rejects(run(removable), rejectsWithCode('batch_not_ready'))
    assert.deepEqual(await projectStore.retryBatchSchemaSuggestion(project.projectContextId, removable, 1), { status: 'not-ready' })
    assert.deepEqual((await db.orm.public.BatchSchemaSuggestion.select('draft', 'draftVersion').first({ id: removable })),
      { draft: ARTICLE_SCHEMA, draftVersion: 1 })
  })
})
