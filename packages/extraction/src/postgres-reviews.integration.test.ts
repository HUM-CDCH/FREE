import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fixture } from './testing/extraction-fixture.js'

describe('Extraction reviews on disposable PostgreSQL', { skip: !fixture && 'set EXTRACTION_TEST_DATABASE_URL (or DATABASE_URL) to a migrated disposable free_test_* database' }, () => {
  if (!fixture) return
  const {
    db, kei, deterministicArtifact, seedProject, addRepresentation,
    createRuntime, freshInput, rejectsWithCode, waitForBatch, cleanup, scheduler, heldByKei, waitForAttempt,
  } = fixture

  it('keeps a draft drafted while the Extraction runs, continues its version across settlement and reports what it dropped', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const module = scheduler(project.researcherAccountId)
    kei.holding = true
    const input = freshInput(project)
    await module.runSingle(input)
    await heldByKei(input.extractionId)
    const id = input.extractionId
    const approve = (record: number, anchor: string, occurrence: string) => ({
      resultPath: ['records', record, 'title'], evidenceAnchorId: anchor, reviewedOccurrenceIds: [occurrence],
      action: 'APPROVED' as const, reviewedValue: null })
    const kept = approve(0, 'a_p1_s0', 'occurrence-alpha')
    const moved = approve(3, 'a_p1_s1', 'occurrence-beta') // kei never links record 3: settlement drops it
    await assert.rejects(module.saveReviewDraft(id, { version: 0, decisions: [approve(0, 'foreign', 'occurrence-alpha')] }),
      rejectsWithCode('invalid_review'))
    assert.deepEqual(await module.saveReviewDraft(id, { version: 0, decisions: [kept, moved] }), { version: 1, decisions: [kept, moved] })
    assert.deepEqual(await module.readReviewDraft(id), { version: 1, decisions: [kept, moved] })
    await assert.rejects(module.saveReviewDraft(id, { version: 0, decisions: [] }), rejectsWithCode('review_conflict'))
    kei.release(id)
    await waitForAttempt(module, id)
    const settled = await module.readReviewDraft(id)
    assert.equal(settled.version, 1)
    assert.deepEqual(settled.decisions, [kept])
    assert.deepEqual(settled.dropped, [{ resultPath: ['records', 3, 'title'], evidenceAnchorId: 'a_p1_s1' }])
    assert.deepEqual(await module.saveReviewDraft(id, { version: 1, decisions: [kept] }), { version: 2, decisions: [kept] })
    assert.equal((await module.readReviewDraft(id)).dropped, undefined)
    await assert.rejects(module.finalizeReview(id, [kept, moved], 2), rejectsWithCode('invalid_review'))
    assert.equal((await module.finalizeReview(id, [kept], 2)).disposition, 'reviewed')
  })

  it('refuses a draft on an Extraction that settled without a result', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const module = scheduler(project.researcherAccountId)
    kei.holding = true
    const input = freshInput(project)
    await module.runSingle(input)
    await heldByKei(input.extractionId)
    assert.equal(await module.cancelSingle(input.extractionId), 'cancellation-requested')
    await waitForAttempt(module, input.extractionId)
    await assert.rejects(module.saveReviewDraft(input.extractionId, { version: 0, decisions: [] }), rejectsWithCode('invalid_review'))
  })

  it('persists drafts independently, rejects invalid and concurrent edits, and clears them atomically on finalization', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const { module } = createRuntime(project.researcherAccountId)
    const { extraction } = await module.runSingle(freshInput(project))
    const id = extraction.extractionId
    const prepared = await module.prepareReview(id)
    const edited = [{ ...prepared.reviewDecisions[0]!, action: 'EDITED' as const, reviewedValue: 'Draft title' }]
    const pending = await module.readReviewDraft(id)
    assert.deepEqual({ version: pending.version, decisions: pending.decisions }, { version: 0, decisions: [] })
    assert.deepEqual(pending.attention, { cells: [{ nodeId: 'title-node', resultPath: ['records', 0, 'title'], presence: 'grounded', decision: null }],
      grounded: 1, ungrounded: 0, missing: 0, requiredRemaining: 1 })
    for (const invalid of [
      [{ ...edited[0]!, evidenceAnchorId: 'foreign-anchor' }],
      [{ ...edited[0]!, reviewedOccurrenceIds: ['foreign-occurrence'] }],
      [{ ...edited[0]!, reviewedValue: 42 }],
      [edited[0]!, edited[0]!],
    ]) await assert.rejects(module.saveReviewDraft(id, { version: 0, decisions: invalid }), rejectsWithCode('invalid_review'))
    const saved = await module.saveReviewDraft(id, { version: 0, decisions: edited })
    assert.equal(saved.version, 1)
    const restored = await createRuntime(project.researcherAccountId).module.readReviewDraft(id)
    assert.deepEqual({ version: restored.version, decisions: restored.decisions }, saved)
    assert.equal(restored.attention?.requiredRemaining, 0)
    assert.deepEqual(restored.attention?.cells[0]?.decision, { action: 'EDITED' })
    const unreviewed = await module.prepareReview(id)
    assert.equal(unreviewed.extraction.reviewedAt, null)
    assert.deepEqual(unreviewed.extraction.reviewDecisions, [])
    await assert.rejects(module.finalizeReview(id, edited, 0), rejectsWithCode('review_conflict'))
    const competing = await Promise.allSettled([
      module.saveReviewDraft(id, { version: 1, decisions: [] }),
      module.saveReviewDraft(id, { version: 1, decisions: prepared.reviewDecisions }),
    ])
    assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1)
    const latest = await module.readReviewDraft(id)
    assert.equal(latest.version, 2)
    const reverted = await module.saveReviewDraft(id, { version: 2, decisions: [] })
    assert.deepEqual(reverted.decisions, [])
    const complete = await module.saveReviewDraft(id, { version: 3, decisions: edited })
    const finalizations = await Promise.all([
      module.finalizeReview(id, edited, complete.version),
      module.finalizeReview(id, edited, complete.version),
    ])
    assert.deepEqual(finalizations.map((result) => result.disposition).sort(), ['replayed', 'reviewed'])
    const finalized = finalizations[0]!
    assert.ok(finalized.extraction.reviewedAt)
    assert.deepEqual((await module.readReviewDraft(id)).decisions, [])
    await assert.rejects(module.saveReviewDraft(id, { version: 4, decisions: [] }), rejectsWithCode('review_conflict'))
    for (const version of [-1, 1.5, Number.NaN])
      await assert.rejects(module.resetReview(id, version), rejectsWithCode('invalid_review'))
    await assert.rejects(module.resetReview(id, 4), rejectsWithCode('review_conflict'))
    const resets = await Promise.allSettled([module.resetReview(id, 5), module.resetReview(id, 5)])
    assert.equal(resets.filter((result) => result.status === 'fulfilled').length, 1)
    const reset = await module.readReviewDraft(id)
    assert.deepEqual({ version: reset.version, decisions: reset.decisions }, { version: 6, decisions: [] })
    assert.equal(reset.attention?.requiredRemaining, 1)
    const reopened = await module.prepareReview(id)
    assert.equal(reopened.extraction.reviewedAt, null)
    assert.deepEqual(reopened.extraction.reviewDecisions, [])
    assert.deepEqual(reopened.extraction.result, prepared.extraction.result)
    await assert.rejects(module.finalizeReview(id, edited, 4), rejectsWithCode('review_conflict'))
    const revised = await module.finalizeReview(id, prepared.reviewDecisions, 6)
    assert.equal(revised.disposition, 'reviewed')
    assert.equal(revised.extraction.reviewDecisions[0]!.action, 'APPROVED')
    const history = await db.orm.public.ExtractionReview.where({ extractionId: id })
      .select('id', 'revisionNumber').orderBy((review) => review.revisionNumber.asc()).all()
    assert.deepEqual(history.map((review) => review.revisionNumber), [1, 2])
    const previousDecision = await db.orm.public.ReviewDecision.where({ extractionReviewId: history[0]!.id }).select('action').first()
    assert.equal(previousDecision?.action, 'EDITED')
  })

it('a stored draft with legacy pairings and carried decisions reads back without them and keeps its version', async (t) => {
    t.after(cleanup)
    const project = await seedProject({ recordDescription: 'One record.', schemaNodes: [
      { id: 'title-node', name: 'title', type: 'string' }, { id: 'note-node', name: 'note', type: 'string' },
    ] })
    const { module } = createRuntime(project.researcherAccountId)
    const { extraction } = await module.runSingle(freshInput(project))
    const prepared = await module.prepareReview(extraction.extractionId)
    const [title, note] = prepared.reviewDecisions
    assert.equal(prepared.reviewDecisions.length, 2)
    // The title decision was carried from a sample; the note decision is the researcher's own, with the empty
    // provenance the old contract allowed.
    const own = { ...note!, action: 'REJECTED' as const, reviewedValue: null }
    const legacy = [
      { ...title!, carriedFrom: { extractionId: 'old-sample', sourcePathKey: '["records",0,"title"]' } },
      { ...own, carriedFrom: null },
    ]
    await db.orm.public.Extraction.where({ id: extraction.extractionId })
      .update({ reviewDraft: legacy, reviewDraftVersion: 4, reviewPairings: [{ record: 0, extractionId: 'old-sample', sourceRecord: 0 }] })
    const draft = await module.readReviewDraft(extraction.extractionId)
    assert.equal(draft.version, 4)
    // A carried decision was never the researcher's own: it is dropped, so the review cannot finalize on it.
    assert.equal(draft.decisions.length, prepared.reviewDecisions.length - 1)
    assert.equal(draft.decisions.some((decision) => 'carriedFrom' in decision), false)
    assert.equal('pairings' in draft, false)
    assert.deepEqual(draft.decisions, [own])
  })

it('projects only the active review revision into batch results after reset', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const { module } = createRuntime(project.researcherAccountId)
    const scheduled = await module.scheduleBatch({
      projectContextId: project.projectContextId, schemaRevisionId: project.schemaRevisionId,
      strategy: 'ARTICLE', sourceDocumentIds: project.documents.map((document) => document.sourceDocumentId),
      repetition: 'create-new', method: { models: null, settings: { article: null } },
    })
    const batch = await waitForBatch(module, project.projectContextId, scheduled.batch.batchExtractionId,
      (batch) => batch.executionStatus === 'COMPLETED')
    const id = batch.members[0]!.latestExtraction!.extractionId
    const input = { projectContextId: project.projectContextId, batchExtractionId: batch.batchExtractionId }
    const original = await module.readBatchResults(input)
    const prepared = await module.prepareReview(id)
    const edited = prepared.reviewDecisions.map((decision) => ({ ...decision, action: 'EDITED' as const, reviewedValue: 'Old title' }))
    await module.finalizeReview(id, edited, 0)
    assert.notDeepEqual(await module.readBatchResults(input), original)
    await module.resetReview(id, 1)
    assert.deepEqual(await module.readBatchResults(input), original)
    await module.finalizeReview(id, prepared.reviewDecisions, 2)
    assert.deepEqual(await module.readBatchResults(input), original)
  })

it('uses the canonical package as review authority and enforces replay and conflict', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const { module } = createRuntime(project.researcherAccountId)
    const completed = await module.runSingle(freshInput(project))
    const extractionId = completed.extraction.extractionId

    const prepared = await module.prepareReview(extractionId)
    assert.deepEqual(prepared.reviewDecisions, [
      {
        resultPath: ['records', 0, 'title'],
        evidenceAnchorId: 'a_p1_s0',
        reviewedOccurrenceIds: ['occurrence-alpha'],
        action: 'APPROVED',
        reviewedValue: null,
      },
    ])
    await assert.rejects(
      module.finalizeReview(extractionId, [
        {
          resultPath: ['records', 0, 'title'],
          evidenceAnchorId: 'a_p1_s0',
          reviewedOccurrenceIds: ['occurrence-beta'],
          action: 'APPROVED',
          reviewedValue: null,
        },
      ]),
      rejectsWithCode('invalid_review'),
    )

    await assert.rejects(
      module.finalizeReview(extractionId, [{
        ...prepared.reviewDecisions[0]!,
        action: 'EDITED',
        reviewedValue: 42,
      }]),
      rejectsWithCode('invalid_review'),
    )
    const edited = [{
      ...prepared.reviewDecisions[0]!,
      action: 'EDITED' as const,
      reviewedValue: 'Alpha corrected',
    }]
    const reviewed = await module.finalizeReview(extractionId, edited)
    assert.equal(reviewed.disposition, 'reviewed')
    assert.ok(reviewed.extraction.reviewedAt)
    assert.deepEqual(
      reviewed.extraction.reviewDecisions.map(({ createdAt: _createdAt, ...decision }) => decision),
      edited,
    )

    const replayed = await module.finalizeReview(extractionId, edited)
    assert.equal(replayed.disposition, 'replayed')
    await assert.rejects(
      module.finalizeReview(extractionId, [
        {
          resultPath: ['records', 0, 'title'],
          evidenceAnchorId: 'a_p1_s0',
          reviewedOccurrenceIds: ['occurrence-alpha'],
          action: 'REJECTED',
          reviewedValue: null,
        },
      ]),
      rejectsWithCode('review_conflict'),
    )

    const missingEvidence = await module.runSingle(freshInput(project))
    await db.orm.public.Extraction.where({
      id: missingEvidence.extraction.extractionId,
    }).update({ evidenceLinks: [] })
    await assert.rejects(
      module.finalizeReview(missingEvidence.extraction.extractionId, []),
      rejectsWithCode('invalid_review'),
    )
  })

it('a stored decision with a legacy carriedFrom still reads back', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const { module } = createRuntime(project.researcherAccountId)
    const run = await module.runSingle(freshInput(project))
    const prepared = await module.prepareReview(run.extraction.extractionId)
    await module.finalizeReview(run.extraction.extractionId, prepared.reviewDecisions)
    const review = (await db.orm.public.ExtractionReview.where({ extractionId: run.extraction.extractionId }).select('id').first())!
    await db.orm.public.ReviewDecision.where({ extractionReviewId: review.id })
      .update({ carriedFrom: { extractionId: 'old-sample', sourcePathKey: '["records",0,"title"]' } })
    const read = await module.readExtractionAttempt(run.extraction.extractionId)
    assert.equal(read?.reviewDecisions.length, prepared.reviewDecisions.length)
    assert.equal(read?.reviewDecisions.some((decision) => 'carriedFrom' in decision), false)
  })

it('a review finalized with carried decisions before this change still replays', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const { module } = createRuntime(project.researcherAccountId)
    const { extraction } = await module.runSingle(freshInput(project))
    const prepared = await module.prepareReview(extraction.extractionId)
    await module.finalizeReview(extraction.extractionId, prepared.reviewDecisions)
    // The digest a pre-change finalize wrote: its normalization carried `carriedFrom` on the first decision.
    const review = (await db.orm.public.ExtractionReview.where({ extractionId: extraction.extractionId }).select('id').first())!
    const first = (await db.orm.public.ReviewDecision.where({ extractionReviewId: review.id }).select('id').orderBy((d) => d.resultPathKey.asc()).first())!
    await db.orm.public.ReviewDecision.where({ id: first.id }).update({ carriedFrom: { extractionId: 'old-sample', sourcePathKey: '["records",0,"title"]' } })
    await db.orm.public.ExtractionReview.where({ id: review.id }).update({ decisionDigest: 'digest-written-by-the-old-normalization' })
    const again = await module.finalizeReview(extraction.extractionId, prepared.reviewDecisions)
    assert.equal(again.disposition, 'replayed')
  })

it('finalizes a partially grounded result without manufacturing Evidence', async (t) => {
    t.after(cleanup)
    const project = await seedProject({
      recordDescription: 'One partially grounded product record.',
      schemaNodes: [
        { id: 'title-node', name: 'title', type: 'string' },
        { id: 'note-node', name: 'note', type: 'string' },
        ...['missing1', 'missing2', 'missing3'].map((name) => ({ id: name, name, type: 'string' as const })),
      ],
    })
    kei.respond = (request) => ({
      artifact: {
        ...deterministicArtifact(request), complete: false,
        records: [{ title: 'Alpha', note: 'Beta' }],
        ungrounded: [['records', 0, 'note']],
      },
    })
    const { module } = createRuntime(project.researcherAccountId)
    const completed = await module.runSingle(freshInput(project))
    assert.equal(completed.extraction.outcome, 'SUCCEEDED')
    assert.equal(completed.extraction.complete, false)
    assert.equal(completed.extraction.reviewable, true)
    assert.equal(completed.extraction.evidence?.length, 1)
    assert.equal(completed.extraction.diagnostics!.ungroundedPaths.length, 1)

    const prepared = await module.prepareReview(completed.extraction.extractionId)
    assert.equal(prepared.reviewDecisions.length, 5)
    const reviewed = await module.finalizeReview(
      completed.extraction.extractionId,
      prepared.reviewDecisions.filter((decision) => decision.evidenceAnchorId !== null),
    )
    assert.equal(reviewed.disposition, 'reviewed')
    assert.ok(reviewed.extraction.reviewedAt)
    assert.equal(reviewed.extraction.reviewDecisions.length, 1)
    assert.equal(reviewed.extraction.diagnostics.ungroundedPaths.length, 1)
    const final = (await module.readReviewDraft(completed.extraction.extractionId)).attention
    assert.equal(final?.requiredRemaining, 0)
    assert.equal(final?.missing, 3)
    assert.equal(final?.ungrounded, 1)
  })

  it('saves and finalizes a canonical correction on a missing path with no model anchor', async (t) => {
    t.after(cleanup)
    const project = await seedProject({ recordDescription: 'One record.', schemaNodes: [
      { id: 'title-node', name: 'title', type: 'string' }, { id: 'note-node', name: 'note', type: 'string' },
    ] })
    const { module } = createRuntime(project.researcherAccountId)
    const id = (await module.runSingle(freshInput(project))).extraction.extractionId
    const prepared = (await module.prepareReview(id)).reviewDecisions
    const grounded = prepared.find((decision) => decision.evidenceAnchorId !== null)!
    const correction = { ...prepared.find((decision) => decision.evidenceAnchorId === null)!, action: 'EDITED' as const, reviewedValue: 'Alpha',
      reviewedEvidence: [{ evidenceAnchorId: grounded.evidenceAnchorId!, reviewedOccurrenceIds: grounded.reviewedOccurrenceIds }] }
    await assert.rejects(module.saveReviewDraft(id, { version: 0, decisions: [{ ...correction, reviewedEvidence: [{ evidenceAnchorId: 'foreign', reviewedOccurrenceIds: [] }] }] }), rejectsWithCode('invalid_review'))
    const draft = await module.saveReviewDraft(id, { version: 0, decisions: [grounded, correction] })
    assert.equal((await module.readReviewDraft(id)).attention?.missing, 1)
    const saved = (await module.finalizeReview(id, draft.decisions, draft.version)).extraction
    assert.equal(saved.reviewDecisions.find((decision) => decision.resultPath[2] === 'note')?.evidenceAnchorId, null)
    assert.deepEqual((await module.prepareReview(id)).extraction.reviewDecisions, saved.reviewDecisions)
  })

it('stores independent value decisions when two paths share one Evidence anchor', async (t) => {
    t.after(cleanup)
    const project = await seedProject({
      recordDescription: 'One record with two grounded values.',
      schemaNodes: [
        { id: 'title-node', name: 'title', type: 'string' },
        { id: 'note-node', name: 'note', type: 'string' },
      ],
    })
    kei.respond = (request) => {
      const artifact = deterministicArtifact(request)
      return { artifact: { ...artifact, records: [{ title: 'Alpha', note: 'Alpha' }], evidence: [
        ...artifact.evidence, { ...artifact.evidence[0]!, path: ['records', 0, 'note'] },
      ] } }
    }
    const { module } = createRuntime(project.researcherAccountId)
    const completed = await module.runSingle(freshInput(project))
    const prepared = await module.prepareReview(completed.extraction.extractionId)
    assert.equal(prepared.reviewDecisions.length, 2)
    assert.equal(new Set(prepared.reviewDecisions.map((decision) => decision.evidenceAnchorId)).size, 1)

    const decisions = prepared.reviewDecisions.map((decision, index) => ({
      ...decision,
      action: index === 0 ? 'EDITED' as const : 'REJECTED' as const,
      reviewedValue: index === 0 ? 'Alpha corrected' : null,
    }))
    const reviewed = await module.finalizeReview(
      completed.extraction.extractionId,
      decisions,
    )
    assert.equal(reviewed.extraction.reviewDecisions.length, 2)
    for (const decision of decisions) {
      const stored = reviewed.extraction.reviewDecisions.find(
        (candidate) => JSON.stringify(candidate.resultPath) === JSON.stringify(decision.resultPath),
      )
      assert.equal(stored?.action, decision.action)
      assert.equal(stored?.reviewedValue, decision.reviewedValue)
      assert.ok(stored?.createdAt)
    }
  })

it('selects latest attempt and latest reviewed across representation history', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const document = project.documents[0]!
    const { module } = createRuntime(project.researcherAccountId)
    const reviewedAttempt = await module.runSingle(freshInput(project))
    const prepared = await module.prepareReview(
      reviewedAttempt.extraction.extractionId,
    )
    await module.finalizeReview(
      reviewedAttempt.extraction.extractionId,
      prepared.reviewDecisions,
    )

    const newerRepresentationId = await addRepresentation(
      document,
      'article-reparsed.pdf',
    )
    const latestAttempt = await module.runSingle({
      ...freshInput(project),
      sourceRepresentationRevisionId: newerRepresentationId,
    })
    const reopened = await module.readDocumentExtractions({
      sourceDocumentId: document.sourceDocumentId,
    })

    assert.equal(
      reopened?.latestAttempt?.extractionId,
      latestAttempt.extraction.extractionId,
    )
    assert.equal(
      reopened?.latestReviewed?.extractionId,
      reviewedAttempt.extraction.extractionId,
    )
    assert.equal(
      reopened?.latestReviewed?.sourceRepresentationRevisionId,
      document.sourceRepresentationRevisionId,
    )
    const historical = await module.readDocumentExtractions({
      sourceDocumentId: document.sourceDocumentId,
      extractionId: reviewedAttempt.extraction.extractionId,
    })
    assert.equal(
      historical?.sourceRepresentationRevisionId,
      document.sourceRepresentationRevisionId,
    )
  })
})
