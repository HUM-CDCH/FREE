import { withHeldSourceDocumentLock } from 'db/postgres-test-helpers'
import { strToU8 } from 'fflate'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { type KeiExtractInput } from './kei-handoff.js'
import { fixture, type SeededDocument } from './testing/extraction-fixture.js'

describe('Extraction ownership on disposable PostgreSQL', { skip: !fixture && 'set EXTRACTION_TEST_DATABASE_URL (or DATABASE_URL) to a migrated disposable free_test_* database' }, () => {
  if (!fixture) return
  const {
    sha256, disposableDatabaseUrl, ARTICLE_SCHEMA, db, createResearcherProjectStore,
    packages, kei, app, seedProject, addRepresentation,
    raceRevision, scheduler, waitForAttempt, createRuntime, freshInput,
    rejectsWithCode, heldByKei, extractionRow, cleanup,
  } = fixture

  it('scopes run, read, review, and cancellation to one researcher', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const foreign = await seedProject()
    const contested = createRuntime(project.researcherAccountId)
    const contestedInput = freshInput(project)
    const accepted = contested.module.runSingle(contestedInput)
    await assert.rejects(
      scheduler(foreign.researcherAccountId).runSingle({
        ...freshInput(foreign),
        extractionId: contestedInput.extractionId,
      }),
      rejectsWithCode('not_found'),
    )
    await accepted
    assert.equal(kei.submissions.length, 1)
    const { module } = createRuntime(project.researcherAccountId)
    const input = freshInput(project)

    const created = await module.runSingle(input)
    assert.equal(created.disposition, 'created')
    assert.equal(created.extraction.outcome, 'SUCCEEDED')
    assert.equal(created.extraction.complete, true)
    assert.deepEqual(created.extraction.result, {
      records: [{ title: 'Alpha', filename: 'article.pdf' }],
    })
    assert.equal(kei.submissions.length, 2)

    const replayed = await module.runSingle(input)
    assert.equal(replayed.disposition, 'replayed')
    assert.equal(replayed.extraction.extractionId, input.extractionId)
    assert.equal(kei.submissions.length, 2)

    await assert.rejects(
      module.runSingle({
        ...freshInput(project),
        schemaRevisionId: foreign.schemaRevisionId,
      }),
      rejectsWithCode('not_found'),
    )
    await assert.rejects(
      module.runSingle(freshInput(foreign)),
      rejectsWithCode('not_found'),
    )
    assert.equal(kei.submissions.length, 2)

    const foreignModule = createRuntime(foreign.researcherAccountId).module
    const foreignExtraction = await foreignModule.runSingle(freshInput(foreign))
    const foreignExtractionId = foreignExtraction.extraction.extractionId
    await assert.rejects(
      module.runSingle({
        ...freshInput(project),
        extractionId: foreignExtractionId,
      }),
      rejectsWithCode('not_found'),
    )
    assert.equal(kei.submissions.length, 3)
    await assert.rejects(
      module.prepareReview(foreignExtractionId),
      rejectsWithCode('not_found'),
    )
    await assert.rejects(module.readReviewDraft(foreignExtractionId), rejectsWithCode('not_found'))
    await assert.rejects(module.saveReviewDraft(foreignExtractionId, { version: 0, decisions: [] }), rejectsWithCode('not_found'))
    await assert.rejects(module.resetReview(foreignExtractionId, 0), rejectsWithCode('not_found'))
    await assert.rejects(
      module.finalizeReview(foreignExtractionId, []),
      rejectsWithCode('not_found'),
    )
    assert.equal(await module.readExtractionAttempt(foreignExtractionId), null)
    assert.equal(
      await module.cancelSingle(foreignExtractionId),
      'not-found',
    )
    assert.equal(
      await module.readDocumentExtractions({
        sourceDocumentId: foreign.documents[0]!.sourceDocumentId,
        extractionId: foreignExtractionId,
      }),
      null,
    )
    const unchanged =
      await db.orm.public.Extraction.select('reviewedAt', 'outcome').first({
        id: foreignExtractionId,
      })
    assert.deepEqual(unchanged, { reviewedAt: null, outcome: 'SUCCEEDED' })
  })

it('reprocessing advances the current source while historical extraction and review pins survive', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const document = project.documents[0]!
    const { module } = createRuntime(project.researcherAccountId)
    const completed = await module.runSingle(freshInput(project))
    const prepared = await module.prepareReview(completed.extraction.extractionId)
    await module.finalizeReview(completed.extraction.extractionId, prepared.reviewDecisions)
    const store = createResearcherProjectStore(project.researcherAccountId, db)
    const annotation = await db.orm.public.AnnotationSetRevision.create({
      sourceDocumentId: document.sourceDocumentId, sourceRepresentationRevisionId: document.sourceRepresentationRevisionId,
      revisionNumber: 1, snapshot: [{ text: 'original note' }],
    })
    const revised = await store.reprocessSourceDocument(project.projectContextId, document.sourceDocumentId, {
      requestKey: randomUUID(), expectedRepresentationId: document.sourceRepresentationRevisionId,
      requestFingerprint: 'f'.repeat(64), contentSha256: sha256(strToU8(document.filename)),
      mediaType: 'application/pdf', originalName: document.filename, ...document.storedPackage,
      contractVersion: 'parsed_document.v2', preprocessId: 'kei-exp:reprocessed:g2', parserName: 'test', parserVersion: '5',
      ensureRetained: async descriptor => { assert.ok(await packages.available(descriptor)) },
    })
    assert.equal(revised?.revisionNumber, 2)
    const current = await module.readDocumentExtractions({ sourceDocumentId: document.sourceDocumentId })
    assert.equal(current?.sourceRepresentationRevisionId, revised?.sourceRepresentationId)
    assert.equal(current?.latestAttempt, null)
    assert.equal((await store.getDocumentReopenSnapshot(project.projectContextId, document.sourceDocumentId))?.annotationSet, null)
    const pinned = await store.getDocumentReopenSnapshot(project.projectContextId, document.sourceDocumentId, {
      sourceRepresentationRevisionId: document.sourceRepresentationRevisionId, schemaRevisionId: project.schemaRevisionId,
    })
    assert.equal(pinned?.annotationSet?.annotationSetId, annotation.id)
    const historical = await module.readDocumentExtractions({ sourceDocumentId: document.sourceDocumentId, extractionId: completed.extraction.extractionId })
    assert.equal(historical?.sourceRepresentationRevisionId, document.sourceRepresentationRevisionId)
    assert.equal(historical?.latestAttempt?.sourceRepresentationRevisionId, document.sourceRepresentationRevisionId)
    const reviewed = await module.prepareReview(completed.extraction.extractionId)
    assert.ok(reviewed.extraction.reviewedAt)
    assert.deepEqual(reviewed.reviewDecisions, prepared.reviewDecisions)
    assert.deepEqual(reviewed.extraction.evidence, prepared.extraction.evidence)
  })

it('refuses a new Extraction on a superseded Source Representation Revision and writes no row', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const document = project.documents[0]!
    await addRepresentation(document, 'article-v2.pdf')
    const module = scheduler(project.researcherAccountId)
    const input = freshInput(project)
    await assert.rejects(module.runSingle(input), rejectsWithCode('source_representation_superseded'))
    assert.equal(await extractionRow(input.extractionId), null)
    assert.deepEqual(await app.admission.listWorkflows({ workflowIDs: [`extract:${input.extractionId}`] }), [])
    await assert.rejects(module.runSingle(freshInput(project)), rejectsWithCode('source_representation_superseded'))
  })

it('admits a new Extraction on the current Source Representation Revision', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const revisionTwo = await addRepresentation(project.documents[0]!, 'article-v2.pdf')
    const { module } = createRuntime(project.researcherAccountId)
    const admitted = await module.runSingle({ ...freshInput(project), sourceRepresentationRevisionId: revisionTwo })
    assert.equal(admitted.disposition, 'created')
    assert.equal(admitted.extraction.sourceRepresentationRevisionId, revisionTwo)
  })

it('replays an identical request after a reprocess instead of refusing it', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const { module } = createRuntime(project.researcherAccountId)
    const input = freshInput(project)
    const first = await module.runSingle(input)
    await addRepresentation(project.documents[0]!, 'article-v2.pdf')
    const again = await module.runSingle(input)
    assert.equal(again.disposition, 'replayed')
    assert.equal(again.extraction.extractionId, first.extraction.extractionId)
    await assert.rejects(module.runSingle({ ...input, strategy: 'CATALOG', method: { models: null, settings: { generic: null } } }),
      rejectsWithCode('extraction_id_conflict'))
  })

it('keeps a run admitted before a reprocess and executes it on its original revision', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const document = project.documents[0]!
    const module = scheduler(project.researcherAccountId)
    kei.holding = true
    const input = freshInput(project)
    const queued = await module.runSingle(input)
    assert.equal(queued.extraction.executionStatus, 'QUEUED')
    await heldByKei(input.extractionId)
    await addRepresentation(document, 'article-v2.pdf')
    kei.release(input.extractionId)
    const executed = await waitForAttempt(module, input.extractionId)
    assert.equal(executed.executionStatus, 'COMPLETED')
    assert.equal(executed.sourceRepresentationRevisionId, document.sourceRepresentationRevisionId)
    const request = kei.submissions.at(-1)!.request as KeiExtractInput
    assert.equal(request.run_id, document.runId)
  })

it('refuses a run that was admitted while a reprocess published a newer revision', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const document = project.documents[0]!
    const module = scheduler(project.researcherAccountId)
    const input = freshInput(project)
    await assert.rejects(
      withHeldSourceDocumentLock(
        disposableDatabaseUrl,
        document.sourceDocumentId,
        () => module.runSingle(input),
        async (run) => { await run(...raceRevision(document.sourceDocumentId)) },
      ),
      rejectsWithCode('source_representation_superseded'),
    )
    assert.equal(await extractionRow(input.extractionId), null)
  })

it('an identical request that waited behind a reprocess replays the Extraction admitted before it', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const document = project.documents[0]!
    const module = scheduler(project.researcherAccountId)
    const input = freshInput(project)
    // Request B reads no Extraction under this ID, then waits on the document lock a reprocess holds. Meanwhile
    // request A's Extraction commits on revision 1 (it needs no lock of the reprocess's), and the reprocess publishes
    // revision 2. Once B holds the lock it reads the identity again and replays A instead of answering superseded.
    const replayed = await withHeldSourceDocumentLock(
      disposableDatabaseUrl,
      document.sourceDocumentId,
      () => module.runSingle(input),
      async (run) => {
        await db.orm.public.Extraction.create({
          id: input.extractionId,
          sourceDocumentId: document.sourceDocumentId,
          sourceRepresentationRevisionId: document.sourceRepresentationRevisionId,
          schemaRevisionId: project.schemaRevisionId,
          strategy: 'ARTICLE',
          catalogRecipe: null,
          requestedModels: null,
          // Request A admitted the same method: service defaults.
          requestedSettings: input.method.settings,
          batchExtractionId: null,
        })
        await run(...raceRevision(document.sourceDocumentId))
      },
    )
    assert.equal(replayed.disposition, 'replayed')
    assert.equal(replayed.extraction.sourceRepresentationRevisionId, document.sourceRepresentationRevisionId)
    assert.deepEqual(await app.admission.listWorkflows({ workflowIDs: [`extract:${input.extractionId}`] }), [])
  })

it('a batch admitted behind a reprocess pins the newly published revision', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const document = project.documents[0]!
    const module = scheduler(project.researcherAccountId)
    const revisionTwo = randomUUID()
    const scheduled = await withHeldSourceDocumentLock(
      disposableDatabaseUrl,
      document.sourceDocumentId,
      () => module.scheduleBatch({
        projectContextId: project.projectContextId,
        schemaRevisionId: project.schemaRevisionId,
        sourceDocumentIds: [document.sourceDocumentId],
        strategy: 'ARTICLE',
        repetition: 'create-new',
      }),
      async (run) => { await run(...raceRevision(document.sourceDocumentId, revisionTwo)) },
    )
    assert.ok(scheduled)
    assert.equal(scheduled.batch.members[0]?.sourceRepresentationRevisionId, revisionTwo)
  })

it('a batch and a reprocess of one of its members both finish', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf', 'two.pdf'])
    const [one, two] = project.documents as [SeededDocument, SeededDocument]
    const module = scheduler(project.researcherAccountId)
    const store = createResearcherProjectStore(project.researcherAccountId, db)
    const [scheduled, revised] = await Promise.all([
      module.scheduleBatch({
        projectContextId: project.projectContextId,
        schemaRevisionId: project.schemaRevisionId,
        sourceDocumentIds: [two.sourceDocumentId, one.sourceDocumentId],
        strategy: 'ARTICLE',
        repetition: 'create-new',
      }),
      store.reprocessSourceDocument(project.projectContextId, two.sourceDocumentId, {
        requestKey: randomUUID(), expectedRepresentationId: two.sourceRepresentationRevisionId,
        requestFingerprint: 'f'.repeat(64), contentSha256: sha256(strToU8(two.filename)),
        mediaType: 'application/pdf', originalName: two.filename, ...two.storedPackage,
        contractVersion: 'parsed_document.v2', preprocessId: 'kei-exp:reprocessed:g2', parserName: 'test', parserVersion: '5',
        ensureRetained: async () => {},
      }),
    ])
    assert.ok(scheduled)
    assert.ok(revised)
    // Either order is valid; the member pins whichever revision was current when it locked.
    const member = scheduled.batch.members.find(
      (candidate) => candidate.sourceDocumentId === two.sourceDocumentId,
    )
    assert.ok(
      member?.sourceRepresentationRevisionId === two.sourceRepresentationRevisionId ||
        member?.sourceRepresentationRevisionId === revised.sourceRepresentationId,
    )
  })

it('conceals a foreign document behind the same missing answer', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const foreign = await seedProject()
    // Supersede the foreign revision: checking currency before ownership would answer superseded.
    await addRepresentation(foreign.documents[0]!, 'foreign-v2.pdf')
    const module = scheduler(project.researcherAccountId)
    await assert.rejects(
      module.runSingle({ ...freshInput(project), sourceRepresentationRevisionId: foreign.documents[0]!.sourceRepresentationRevisionId }),
      rejectsWithCode('not_found'),
    )
  })
})
