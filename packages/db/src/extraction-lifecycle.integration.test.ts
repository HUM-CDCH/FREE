import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { db } from './prisma/db.js'
import { createProjectStore, type TerminalExtractionInput } from './project-store.js'

const enabled = Boolean(process.env.EXTRACTION_TEST_DATABASE_URL)
const diagnostics = {
  phase: 'grounding',
  durationMs: 1,
  modelCalls: 1,
  finishReason: 'stop',
  inputTokens: 10,
  outputTokens: 4,
  grounding: {
    groundedPaths: [['records', 0, 'title']],
    ungroundedPaths: [],
    issueCodes: [],
    batches: [],
  },
  catalog: null,
}

describe('ProjectStore Extraction lifecycle on PostgreSQL', { skip: !enabled }, () => {
  it('enforces terminal shapes, transactions, concurrency, idempotency, and independent reopen pins', async () => {
    const projectContextId = randomUUID()
    const sourceDocumentId = randomUUID()
    const otherDocumentId = randomUUID()
    const representation1 = randomUUID()
    const representation2 = randomUUID()
    const otherRepresentation = randomUUID()
    const extractionSchemaId = randomUUID()
    const schemaRevision1 = randomUUID()
    const schemaRevision2 = randomUUID()
    const store = createProjectStore()

    await db.orm.public.ProjectContext.create({ id: projectContextId, name: 'Extraction test' })
    await db.orm.public.SourceDocument.create({
      id: sourceDocumentId,
      projectContextId,
      contentSha256: 'a'.repeat(64),
      mediaType: 'application/pdf',
      originalName: 'source.pdf',
    })
    await db.orm.public.SourceDocument.create({
      id: otherDocumentId,
      projectContextId,
      contentSha256: 'b'.repeat(64),
      mediaType: 'application/pdf',
      originalName: 'other.pdf',
    })
    for (const [id, documentId, revision, hash] of [
      [representation1, sourceDocumentId, 1, '1'],
      [representation2, sourceDocumentId, 2, '2'],
      [otherRepresentation, otherDocumentId, 1, '3'],
    ] as const)
      await db.orm.public.SourceRepresentationRevision.create({
        id,
        sourceDocumentId: documentId,
        revisionNumber: revision,
        artifactReference: hash.repeat(64),
        artifactSha256: hash.repeat(64),
        contractVersion: 'parsed_document.v2',
        preprocessId: `preprocess-${revision}-${hash}`,
        parserName: 'fixture',
        parserVersion: '1',
      })
    await db.orm.public.ExtractionSchema.create({
      id: extractionSchemaId,
      projectContextId,
      name: 'Extraction schema',
    })
    await db.orm.public.SchemaRevision.create({
      id: schemaRevision1,
      extractionSchemaId,
      revisionNumber: 1,
      origin: 'RESEARCHER_EDIT',
      schemaTree: {
        recordDescription: 'One title record.',
        schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
      },
    })
    await db.orm.public.SchemaRevision.create({
      id: schemaRevision2,
      extractionSchemaId,
      revisionNumber: 2,
      origin: 'RESEARCHER_EDIT',
      schemaTree: {
        recordDescription: 'One title record.',
        schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
      },
    })

    const terminal = (
      extractionId: string,
      sourceRepresentationRevisionId = representation1,
      schemaRevisionId = schemaRevision1,
      sourceId = sourceDocumentId,
    ): TerminalExtractionInput => ({
      extractionId,
      sourceDocumentId: sourceId,
      sourceRepresentationRevisionId,
      schemaRevisionId,
      strategy: 'ARTICLE',
      outcome: 'SUCCEEDED',
      complete: true,
      modelAttribution: { provider: 'ollama', modelId: 'fixture' },
      diagnostics,
      failure: null,
      resultPayload: { records: [{ title: 'Ellekilde' }] },
      evidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' }],
      reviewable: true,
      retryOfId: null,
    })

    const idempotentId = randomUUID()
    assert.equal((await store.persistExtractionAttempt(terminal(idempotentId))).status, 'created')
    assert.equal((await store.persistExtractionAttempt(terminal(idempotentId))).status, 'replayed')
    assert.equal(
      (
        await store.persistExtractionAttempt({
          ...terminal(randomUUID()),
          strategy: 'CATALOG',
          diagnostics: {
            ...diagnostics,
            catalog: {
              codes: [],
              documentMetadata: null,
              discovery: {
                outcome: 'succeeded',
                finishReason: 'stop',
                inputTokens: 1,
                outputTokens: 1,
                durationMs: 1,
                candidateCount: 0,
                returnedCount: 0,
                resolvedCount: 0,
              },
              boundaries: [],
              boundaryIssues: [],
              records: [],
            },
          },
        })
      ).status,
      'created',
    )
    assert.equal(
      (await store.persistExtractionAttempt(terminal(idempotentId, representation2, schemaRevision2))).status,
      'conflict',
    )

    const concurrentPersistId = randomUUID()
    const identicalPersists = await Promise.all([
      store.persistExtractionAttempt(terminal(concurrentPersistId)),
      store.persistExtractionAttempt(terminal(concurrentPersistId)),
    ])
    assert.deepEqual(
      new Set(identicalPersists.map(({ status }) => status)),
      new Set(['created', 'replayed']),
    )
    const mismatchedPersistId = randomUUID()
    const mismatchedPersists = await Promise.all([
      store.persistExtractionAttempt(terminal(mismatchedPersistId)),
      store.persistExtractionAttempt(
        terminal(mismatchedPersistId, representation2, schemaRevision2),
      ),
    ])
    assert.deepEqual(
      new Set(mismatchedPersists.map(({ status }) => status)),
      new Set(['created', 'conflict']),
    )

    await assert.rejects(
      db.orm.public.Extraction.create({
        id: randomUUID(),
        sourceDocumentId,
        sourceRepresentationRevisionId: representation1,
        schemaRevisionId: schemaRevision1,
        strategy: 'ARTICLE',
        outcome: 'SUCCEEDED',
        complete: true,
        modelAttribution: { provider: 'ollama', modelId: 'fixture' },
        diagnostics,
        failure: null,
        resultPayload: null,
        evidenceLinks: [],
        reviewable: false,
        retryOfId: null,
      }),
    )

    const nullDiagnostics = terminal(randomUUID())
    await assert.rejects(
      db.orm.public.Extraction.create({
        id: nullDiagnostics.extractionId,
        sourceDocumentId,
        sourceRepresentationRevisionId: representation1,
        schemaRevisionId: schemaRevision1,
        strategy: 'ARTICLE',
        outcome: 'SUCCEEDED',
        complete: true,
        modelAttribution: nullDiagnostics.modelAttribution,
        diagnostics: null as never,
        failure: null,
        resultPayload: nullDiagnostics.resultPayload,
        evidenceLinks: nullDiagnostics.evidenceLinks,
        reviewable: true,
        retryOfId: null,
      }),
    )

    const crossDocumentRetry = terminal(
      randomUUID(),
      otherRepresentation,
      schemaRevision1,
      otherDocumentId,
    )
    crossDocumentRetry.retryOfId = idempotentId
    await assert.rejects(store.persistExtractionAttempt(crossDocumentRetry))
    const changedPinRetry = terminal(randomUUID(), representation2, schemaRevision1)
    changedPinRetry.retryOfId = idempotentId
    await assert.rejects(store.persistExtractionAttempt(changedPinRetry))
    const selfRetryId = randomUUID()
    const selfRetry = terminal(selfRetryId)
    selfRetry.retryOfId = selfRetryId
    await assert.rejects(store.persistExtractionAttempt(selfRetry))

    const concurrentId = randomUUID()
    await store.persistExtractionAttempt(terminal(concurrentId))
    const ownership = new Map([['anchor-1', new Set(['occurrence-1', 'occurrence-2'])]])
    const requiredResultPathKeys = new Set(['["records",0,"title"]'])
    const [left, right] = await Promise.all([
      store.finalizeExtractionReview(concurrentId, {
        reviewDecisions: [{ evidenceAnchorId: 'anchor-1', reviewedOccurrenceIds: ['occurrence-1'] }],
        occurrenceIdsByAnchor: ownership,
        requiredResultPathKeys,
      }),
      store.finalizeExtractionReview(concurrentId, {
        reviewDecisions: [{ evidenceAnchorId: 'anchor-1', reviewedOccurrenceIds: ['occurrence-2'] }],
        occurrenceIdsByAnchor: ownership,
        requiredResultPathKeys,
      }),
    ])
    assert.deepEqual(new Set([left.status, right.status]), new Set(['reviewed', 'conflict']))

    const identicalReviewId = randomUUID()
    await store.persistExtractionAttempt(terminal(identicalReviewId))
    const identical = await Promise.all([
      store.finalizeExtractionReview(identicalReviewId, {
        reviewDecisions: [{ evidenceAnchorId: 'anchor-1', reviewedOccurrenceIds: ['occurrence-1'] }],
        occurrenceIdsByAnchor: ownership,
        requiredResultPathKeys,
      }),
      store.finalizeExtractionReview(identicalReviewId, {
        reviewDecisions: [{ evidenceAnchorId: 'anchor-1', reviewedOccurrenceIds: ['occurrence-1'] }],
        occurrenceIdsByAnchor: ownership,
        requiredResultPathKeys,
      }),
    ])
    assert.deepEqual(new Set(identical.map(({ status }) => status)), new Set(['reviewed', 'replayed']))

    const ungroundedReviewId = randomUUID()
    const ungroundedReview = terminal(ungroundedReviewId)
    ungroundedReview.evidenceLinks = []
    await store.persistExtractionAttempt(ungroundedReview)
    assert.equal(
      (
        await store.finalizeExtractionReview(ungroundedReviewId, {
          reviewDecisions: [],
          occurrenceIdsByAnchor: ownership,
          requiredResultPathKeys,
        })
      ).status,
      'invalid',
    )
    assert.equal(
      (await store.getExtractionAttempt(ungroundedReviewId))?.reviewedAt,
      null,
    )

    const reviewedId = randomUUID()
    await store.persistExtractionAttempt(terminal(reviewedId))
    assert.equal(
      (
        await store.finalizeExtractionReview(reviewedId, {
          reviewDecisions: [{ evidenceAnchorId: 'anchor-1', reviewedOccurrenceIds: ['occurrence-1'] }],
          occurrenceIdsByAnchor: ownership,
          requiredResultPathKeys,
        })
      ).status,
      'reviewed',
    )
    const newerId = randomUUID()
    await store.persistExtractionAttempt(
      terminal(newerId, representation2, schemaRevision2),
    )
    await store.persistExtractionAttempt(
      terminal(
        randomUUID(),
        otherRepresentation,
        schemaRevision2,
        otherDocumentId,
      ),
    )
    const reopened = await store.getDocumentReopenSnapshot(
      projectContextId,
      sourceDocumentId,
    )
    assert.equal(reopened?.latestAttempt?.extractionId, newerId)
    assert.equal(
      reopened?.latestAttempt?.sourceRepresentationRevisionId,
      representation2,
    )
    assert.equal(reopened?.latestAttempt?.schemaRevisionId, schemaRevision2)
    assert.equal(reopened?.latestReviewed?.extractionId, reviewedId)
    assert.equal(
      reopened?.latestReviewed?.sourceRepresentationRevisionId,
      representation1,
    )
    assert.equal(reopened?.latestReviewed?.schemaRevisionId, schemaRevision1)

    await assert.rejects(
      db.orm.public.Extraction.where({ id: newerId }).update({ complete: false }),
    )
    await assert.rejects(
      db.orm.public.Extraction.where({ id: newerId }).delete(),
    )
  })
})
