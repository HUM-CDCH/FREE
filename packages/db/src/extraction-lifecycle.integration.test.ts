import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { db } from './prisma/db.js'
import { createProjectStore, type TerminalExtractionInput } from './project-store.js'

const enabled =
  Boolean(process.env.EXTRACTION_TEST_DATABASE_URL) &&
  process.env.DATABASE_URL === process.env.EXTRACTION_TEST_DATABASE_URL
const diagnostics = {
  phase: 'grounding',
  durationMs: 1,
  modelCalls: 1,
  finishReason: 'stop',
  inputTokens: 10,
  outputTokens: 4,
  values: {
    outcome: 'succeeded',
    finishReason: 'stop',
    inputTokens: 10,
    outputTokens: 4,
    durationMs: 1,
  },
  grounding: {
    groundedPaths: [['records', 0, 'title']],
    ungroundedPaths: [],
    issueCodes: [],
    batches: [],
  },
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
      ingestionKey: sourceDocumentId,
      contentSha256: 'a'.repeat(64),
      mediaType: 'application/pdf',
      originalName: 'source.pdf',
    })
    await db.orm.public.SourceDocument.create({
      id: otherDocumentId,
      projectContextId,
      ingestionKey: otherDocumentId,
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
      batchExtractionId: null,
    })

    const batchExtractionId = randomUUID()
    assert.equal(
      (
        await store.createBatchExtraction(projectContextId, {
          batchExtractionId,
          schemaRevisionId: schemaRevision1,
          strategy: 'ARTICLE',
          sourceDocumentIds: [sourceDocumentId],
        })
      )?.status,
      'created',
    )
    const olderBatchExtractionId = randomUUID()
    const olderBatchExtraction = terminal(
      olderBatchExtractionId,
      representation2,
      schemaRevision1,
    )
    olderBatchExtraction.batchExtractionId = batchExtractionId
    assert.equal(
      (await store.persistExtractionAttempt(olderBatchExtraction)).status,
      'created',
    )
    assert.deepEqual(
      await store.getBatchExtractionResults(projectContextId, batchExtractionId),
      {
        batchExtractionId,
        executionStatus: 'QUEUED',
        totalMembers: 1,
        successfulResults: 1,
        pending: 0,
        failed: 0,
        cancelled: 0,
        results: [
          {
            sourceDocumentId,
            extractionId: olderBatchExtractionId,
            resultPayload: { records: [{ title: 'Ellekilde' }] },
          },
        ],
      },
    )
    await db.orm.public.SchemaRevision.create({
      id: schemaRevision2,
      extractionSchemaId,
      revisionNumber: 2,
      origin: 'RESEARCHER_EDIT',
      schemaTree: {
        recordDescription: 'One title and year record.',
        schemaNodes: [
          { id: 'title', name: 'title', type: 'string' },
          { id: 'year', name: 'year', type: 'string' },
        ],
      },
    })
    const reopenedOlderBatchExtraction = await store.getDocumentReopenSnapshot(
      projectContextId,
      sourceDocumentId,
      olderBatchExtractionId,
    )
    assert.equal(
      reopenedOlderBatchExtraction?.latestAttempt?.extractionId,
      olderBatchExtractionId,
    )
    assert.equal(
      reopenedOlderBatchExtraction?.sourceRepresentation.sourceRepresentationId,
      representation2,
    )
    assert.equal(
      reopenedOlderBatchExtraction?.extractionSchema?.schemaRevisionId,
      schemaRevision1,
    )
    assert.equal(
      reopenedOlderBatchExtraction?.extractionSchema?.revisionNumber,
      1,
    )
    assert.deepEqual(reopenedOlderBatchExtraction?.extractionSchema?.schemaTree, {
      recordDescription: 'One title record.',
      schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
    })

    const idempotentId = randomUUID()
    assert.equal((await store.persistExtractionAttempt(terminal(idempotentId))).status, 'created')
    assert.equal((await store.persistExtractionAttempt(terminal(idempotentId))).status, 'replayed')
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
    assert.equal(reopened?.latestReviewed, null)

    await assert.rejects(
      db.orm.public.Extraction.where({ id: newerId }).update({ complete: false }),
    )
    await assert.rejects(
      db.orm.public.Extraction.where({ id: newerId }).delete(),
    )
  })

  it('maps each Batch Extraction member to its own latest Extraction Result', async () => {
    const projectContextId = randomUUID()
    const firstDocumentId = randomUUID()
    const secondDocumentId = randomUUID()
    const firstRepresentationId = randomUUID()
    const secondRepresentationId = randomUUID()
    const extractionSchemaId = randomUUID()
    const schemaRevisionId = randomUUID()
    const batchExtractionId = randomUUID()
    const firstOlderExtractionId = randomUUID()
    const firstExtractionId = randomUUID()
    const secondExtractionId = randomUUID()
    const store = createProjectStore()

    await db.orm.public.ProjectContext.create({
      id: projectContextId,
      name: 'Batch result correlation test',
    })
    try {
      for (const [documentId, representationId, hash, originalName] of [
        [firstDocumentId, firstRepresentationId, 'c', 'first.pdf'],
        [secondDocumentId, secondRepresentationId, 'd', 'second.pdf'],
      ] as const) {
        await db.orm.public.SourceDocument.create({
          id: documentId,
          projectContextId,
          ingestionKey: documentId,
          contentSha256: hash.repeat(64),
          mediaType: 'application/pdf',
          originalName,
        })
        await db.orm.public.SourceRepresentationRevision.create({
          id: representationId,
          sourceDocumentId: documentId,
          revisionNumber: 1,
          artifactReference: hash.repeat(64),
          artifactSha256: hash.repeat(64),
          contractVersion: 'parsed_document.v2',
          preprocessId: `preprocess-${hash}`,
          parserName: 'fixture',
          parserVersion: '1',
        })
      }
      await db.orm.public.ExtractionSchema.create({
        id: extractionSchemaId,
        projectContextId,
        name: 'Batch result correlation schema',
      })
      await db.orm.public.SchemaRevision.create({
        id: schemaRevisionId,
        extractionSchemaId,
        revisionNumber: 1,
        origin: 'RESEARCHER_EDIT',
        schemaTree: {
          recordDescription: 'One title record.',
          schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
        },
      })
      assert.equal(
        (
          await store.createBatchExtraction(projectContextId, {
            batchExtractionId,
            schemaRevisionId,
            strategy: 'ARTICLE',
            sourceDocumentIds: [firstDocumentId, secondDocumentId],
          })
        )?.status,
        'created',
      )
      for (const [
        extractionId,
        sourceDocumentId,
        sourceRepresentationRevisionId,
        title,
        createdAt,
      ] of [
        [
          firstOlderExtractionId,
          firstDocumentId,
          firstRepresentationId,
          'Superseded title',
          new Date('2026-08-19T09:59:00.000Z'),
        ],
        [
          firstExtractionId,
          firstDocumentId,
          firstRepresentationId,
          'Ellekilde',
          new Date('2026-08-19T10:00:00.000Z'),
        ],
        [
          secondExtractionId,
          secondDocumentId,
          secondRepresentationId,
          'Grundtvig',
          new Date('2026-08-19T10:01:00.000Z'),
        ],
      ] as const)
        await db.orm.public.Extraction.create({
          id: extractionId,
          sourceDocumentId,
          sourceRepresentationRevisionId,
          schemaRevisionId,
          batchExtractionId,
          strategy: 'ARTICLE',
          outcome: 'SUCCEEDED',
          complete: true,
          modelAttribution: { provider: 'ollama', modelId: 'fixture' },
          diagnostics,
          resultPayload: { records: [{ title }] },
          evidenceLinks: [],
          reviewable: true,
          createdAt,
        })

      const result = await store.getBatchExtractionResults(
        projectContextId,
        batchExtractionId,
      )
      assert.equal(result?.totalMembers, 2)
      assert.equal(result?.successfulResults, 2)
      assert.deepEqual(
        new Map(
          result?.results.map((memberResult) => [
            memberResult.sourceDocumentId,
            {
              extractionId: memberResult.extractionId,
              resultPayload: memberResult.resultPayload,
            },
          ]),
        ),
        new Map([
          [
            firstDocumentId,
            {
              extractionId: firstExtractionId,
              resultPayload: { records: [{ title: 'Ellekilde' }] },
            },
          ],
          [
            secondDocumentId,
            {
              extractionId: secondExtractionId,
              resultPayload: { records: [{ title: 'Grundtvig' }] },
            },
          ],
        ]),
      )
    } finally {
      await db.orm.public.ProjectContext.where({ id: projectContextId }).delete()
    }
  })
})
