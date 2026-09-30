import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fixture } from './testing/extraction-fixture.js'

describe('Extraction reviews on disposable PostgreSQL', { skip: !fixture && 'set EXTRACTION_TEST_DATABASE_URL (or DATABASE_URL) to a migrated disposable free_test_* database' }, () => {
  if (!fixture) return
  const {
    db, kei, deterministicArtifact, seedProject, addRepresentation,
    createRuntime, freshInput, rejectsWithCode, waitForBatch, cleanup,
  } = fixture

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
    assert.deepEqual(restored.attention?.cells[0]?.decision, { action: 'EDITED', provenance: 'explicit' })
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

  for (const batchMember of [false, true]) it(`seeds a ${batchMember ? 'batch member' : 'single run'} whose every value carries, requiring explicit finalization`, async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const { module } = createRuntime(project.researcherAccountId)
    const sample = (await module.runSingle({ ...freshInput(project), pages: [1] })).extraction.extractionId
    await module.saveReviewDraft(sample, { version: 0, decisions: (await module.prepareReview(sample)).reviewDecisions })
    let full: string
    if (batchMember) {
      const scheduled = await module.scheduleBatch({ projectContextId: project.projectContextId, schemaRevisionId: project.schemaRevisionId,
        strategy: 'ARTICLE', sourceDocumentIds: [project.documents[0]!.sourceDocumentId], repetition: 'create-new', method: { models: null, settings: { article: null } } })
      const batch = await waitForBatch(module, project.projectContextId, scheduled.batch.batchExtractionId, (batch) => batch.executionStatus === 'COMPLETED')
      full = batch.members[0]!.latestExtraction!.extractionId
      assert.equal((await module.readExtractionAttempt(full))?.batchExtractionId, scheduled.batch.batchExtractionId)
    } else full = (await module.runSingle(freshInput(project))).extraction.extractionId
    const prepared = await module.prepareReview(full)
    const seeded = await module.readReviewDraft(full)
    assert.deepEqual(seeded, {
      version: 0,
      decisions: prepared.reviewDecisions.map((decision) => ({
        ...decision, carriedFrom: { extractionId: sample, sourcePathKey: JSON.stringify(decision.resultPath) },
      })),
      transfer: { '["records",0,"title"]': { status: 'reviewed', kept: 'Alpha' } },
      sources: [],
      attention: { cells: [{ nodeId: 'title-node', resultPath: ['records', 0, 'title'], presence: 'grounded',
        decision: { action: 'APPROVED', provenance: 'carried' } }], grounded: 1, ungrounded: 0, missing: 0, requiredRemaining: 0 },
    })
    assert.equal(seeded.decisions.length, 1)
    assert.equal(prepared.extraction.reviewedAt, null)
    assert.deepEqual(prepared.extraction.reviewDecisions, [])
    assert.equal((await module.finalizeReview(full, seeded.decisions, 0)).disposition, 'reviewed')
    const [review] = await db.orm.public.ExtractionReview.where({ extractionId: full }).select('id').all()
    assert.deepEqual((await db.orm.public.ReviewDecision.where({ extractionReviewId: review!.id }).select('carriedFrom').all())
      .map((decision) => decision.carriedFrom), seeded.decisions.map((decision) => decision.carriedFrom))
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
